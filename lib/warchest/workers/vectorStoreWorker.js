'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const baseLogger = require('../../logger');
const { createWorkerHarness, safeSerializePayload, createLifecycleLogger } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');

const logger = createWorkerLogger({
  workerName: 'vectorStoreWorker',
  scope: 'vectorStoreWorker',
  baseLogger,
  includeCallsite: true,
});
const metricsLogger = typeof baseLogger.metrics === 'function'
  ? baseLogger.metrics()
  : baseLogger;

/**
 * @typedef {Object} VectorStoreWorkerPayload
 * @property {string} [vectorStoreId]
 * @property {string} [source]
 * @property {string} [name]
 * @property {string} [jsonPath]
 * @property {boolean} [cleanupPath]
 */

function buildMetricsPayload(event) {
  const details = event?.result || event?.payload || {};
  return {
    worker: event?.worker || 'vectorStoreWorker',
    event: event?.event || null,
    requestId: event?.requestId || null,
    durationMs: event?.durationMs ?? null,
    ...(details.source ? { source: details.source } : {}),
    ...(details.vectorStoreId ? { vectorStoreId: details.vectorStoreId } : {}),
    ...(details.fileId ? { fileId: details.fileId } : {}),
  };
}

function createVectorStoreMetricsReporter() {
  if (!metricsLogger || typeof metricsLogger.debug !== 'function') return null;
  return (event) => {
    const payload = buildMetricsPayload(event);
    metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
  };
}

function resolveVectorStoreClient(openai) {
  return openai.vectorStores || (openai.beta && openai.beta.vectorStores) || null;
}

async function uploadJsonFile({
  vectorStoreId,
  jsonPath,
  source,
  name,
  cleanupPath,
}) {
  const resolvedStoreId = vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;
  if (!resolvedStoreId) {
    logger.warn('[vectorStoreWorker] WARLORDAI_VECTOR_STORE missing; skipping upload');
    return { skipped: true, reason: 'missing_vector_store', source };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[vectorStoreWorker] OPENAI_API_KEY missing; skipping upload');
    return { skipped: true, reason: 'missing_openai_key', source };
  }
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    throw new Error('[vectorStoreWorker] jsonPath is required and must exist');
  }

  const openai = new OpenAI({ apiKey });
  try {
    const filePath = jsonPath;
    const file = await openai.files.create({
      file: fs.createReadStream(filePath),
      purpose: 'assistants',
    });
    logger.debug('[vectorStoreWorker] Uploaded file', { source, fileId: file.id, name });

    const vectorStores = resolveVectorStoreClient(openai);
    if (!vectorStores) {
      throw new Error('Vector store API not available on OpenAI client');
    }
    if (vectorStores.fileBatches && typeof vectorStores.fileBatches.create === 'function') {
      await vectorStores.fileBatches.create(resolvedStoreId, {
        file_ids: [file.id],
      });
    } else if (vectorStores.files && typeof vectorStores.files.create === 'function') {
      await vectorStores.files.create(resolvedStoreId, {
        file_id: file.id,
      });
    } else {
      throw new Error('Vector store attach API not available on OpenAI client');
    }

    logger.info('[vectorStoreWorker] Stored in vector store', {
      vectorStoreId: resolvedStoreId,
      fileId: file.id,
      source,
      name,
    });

    return {
      vectorStoreId: resolvedStoreId,
      fileId: file.id,
      source,
      name,
    };
  } finally {
    if (cleanupPath && jsonPath) {
      try { await fs.promises.unlink(jsonPath); } catch (_) {}
    }
  }
}

/**
 * Run the vector store upload worker.
 *
 * @param {VectorStoreWorkerPayload} payload
 * @returns {Promise<Object>}
 */
async function runVectorStoreWorker(payload) {
  const normalized = validateVectorStorePayload(payload);
  return uploadJsonFile(normalized);
}

/**
 * Validate and normalize vector store payloads.
 *
 * @param {VectorStoreWorkerPayload} payload
 * @returns {VectorStoreWorkerPayload}
 */
function validateVectorStorePayload(payload) {
  const out = {};
  if (payload?.vectorStoreId) out.vectorStoreId = String(payload.vectorStoreId).trim();
  if (payload?.source) out.source = String(payload.source).trim();
  if (payload?.name) out.name = String(payload.name).trim();
  if (payload?.jsonPath) out.jsonPath = String(payload.jsonPath).trim();
  if (payload?.cleanupPath) out.cleanupPath = Boolean(payload.cleanupPath);
  return out;
}

function parseStandaloneArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const out = { payloadFile: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--payload-file') {
      out.payloadFile = args[i + 1] || null;
      i += 1;
    }
  }
  return out;
}

/**
 * Run detached uploads without IPC (used by spawnWorkerDetached).
 *
 * @param {VectorStoreWorkerPayload} payload
 * @returns {Promise<void>}
 */
async function runStandalone(payload) {
  const lifecycle = createLifecycleLogger('vectorStoreWorker', logger, createVectorStoreMetricsReporter());
  const requestId = `detached-${randomUUID()}`;
  const startedAt = Date.now();

  lifecycle.start(requestId, {
    source: payload?.source,
    vectorStoreId: payload?.vectorStoreId || process.env.WARLORDAI_VECTOR_STORE,
    jsonPath: payload?.jsonPath,
  });

  try {
    const result = await runVectorStoreWorker(payload);
    lifecycle.success(requestId, result, startedAt);
  } catch (err) {
    lifecycle.error(requestId, err, startedAt);
    throw err;
  } finally {
    lifecycle.cleanup(requestId);
  }
}

if (require.main === module) {
  const args = parseStandaloneArgs(process.argv);
  if (args.payloadFile) {
    (async () => {
      const payload = JSON.parse(fs.readFileSync(args.payloadFile, 'utf8'));
      await runStandalone(payload);
      process.exit(0);
    })().catch((err) => {
      logger.error('[vectorStoreWorker] standalone failed', { err: err?.message || err });
      process.exit(1);
    });
  } else {
    createWorkerHarness(runVectorStoreWorker, {
      workerName: 'vectorStoreWorker',
      logger,
      metricsReporter: createVectorStoreMetricsReporter(),
    });
  }
}

module.exports = { validateVectorStorePayload, runVectorStoreWorker };
