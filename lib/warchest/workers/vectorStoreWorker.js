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
 * @property {Object} [attributes]
 * @property {string} [jsonPath]
 * @property {boolean} [cleanupPath]
 * @property {string} [action]
 * @property {string} [fileId]
 * @property {boolean} [deleteFile]
 * @property {string} [targetMint]
 * @property {string} [replaceFileId]
 * @property {string} [replaceVectorStoreId]
 * @property {boolean} [deleteReplacedFile]
 * @property {string|string[]} [prefix]
 * @property {number} [olderThanSeconds]
 * @property {number} [olderThanHours]
 * @property {boolean} [dryRun]
 * @property {number} [maxDeletes]
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

function normalizeAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (Object.keys(out).length >= 16) break;
    let nextValue = value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      try {
        nextValue = JSON.stringify(value);
      } catch (_) {
        nextValue = String(value);
      }
    }
    const serialized = String(nextValue);
    out[key] = serialized.length > 256 ? serialized.slice(0, 256) : serialized;
  }
  return Object.keys(out).length ? out : null;
}

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizePrefixList(prefixes) {
  const raw = [];
  if (Array.isArray(prefixes)) {
    raw.push(...prefixes);
  } else if (typeof prefixes === 'string') {
    prefixes.split(',').forEach((item) => raw.push(item));
  } else if (prefixes != null) {
    raw.push(String(prefixes));
  }

  const normalized = raw
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);

  return normalized.length ? normalized : ['targetscan'];
}

function matchesPrefix(value, prefixes) {
  if (!value) return false;
  const candidate = String(value).trim().toLowerCase();
  if (!candidate) return false;
  return prefixes.some((prefix) => candidate.startsWith(prefix));
}

async function uploadJsonFile({
  vectorStoreId,
  jsonPath,
  source,
  name,
  attributes,
  cleanupPath,
  targetMint,
  replaceFileId,
  replaceVectorStoreId,
  deleteReplacedFile,
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
  const resolvedAttributes = normalizeAttributes(attributes);
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
    let attachResult = null;
    if (vectorStores.fileBatches && typeof vectorStores.fileBatches.createAndPoll === 'function') {
      attachResult = await vectorStores.fileBatches.createAndPoll(resolvedStoreId, {
        files: resolvedAttributes
          ? [{ file_id: file.id, attributes: resolvedAttributes }]
          : undefined,
        file_ids: resolvedAttributes ? undefined : [file.id],
      });
      if (attachResult?.status && attachResult.status !== 'completed') {
        logger.warn('[vectorStoreWorker] File batch not completed', {
          vectorStoreId: resolvedStoreId,
          fileId: file.id,
          status: attachResult.status,
          fileCounts: attachResult.file_counts || null,
        });
      }
    } else if (vectorStores.files && typeof vectorStores.files.createAndPoll === 'function') {
      attachResult = await vectorStores.files.createAndPoll(resolvedStoreId, {
        file_id: file.id,
        attributes: resolvedAttributes || undefined,
      });
      if (attachResult?.status && attachResult.status !== 'completed') {
        logger.warn('[vectorStoreWorker] Vector store file not completed', {
          vectorStoreId: resolvedStoreId,
          fileId: file.id,
          status: attachResult.status,
          lastError: attachResult.last_error || null,
        });
      }
    } else if (vectorStores.fileBatches && typeof vectorStores.fileBatches.create === 'function') {
      attachResult = await vectorStores.fileBatches.create(resolvedStoreId, {
        files: resolvedAttributes
          ? [{ file_id: file.id, attributes: resolvedAttributes }]
          : undefined,
        file_ids: resolvedAttributes ? undefined : [file.id],
      });
    } else if (vectorStores.files && typeof vectorStores.files.create === 'function') {
      attachResult = await vectorStores.files.create(resolvedStoreId, {
        file_id: file.id,
        attributes: resolvedAttributes || undefined,
      });
    } else {
      throw new Error('Vector store attach API not available on OpenAI client');
    }

    logger.info('[vectorStoreWorker] Stored in vector store', {
      vectorStoreId: resolvedStoreId,
      fileId: file.id,
      source,
      name,
      status: attachResult?.status || null,
      attributes: resolvedAttributes || null,
    });

    if (replaceFileId && replaceFileId !== file.id) {
      try {
        await deleteVectorStoreFile({
          vectorStoreId: replaceVectorStoreId || resolvedStoreId,
          fileId: replaceFileId,
          deleteFile: deleteReplacedFile === true,
          source,
          name,
          openai,
        });
      } catch (err) {
        logger.warn('[vectorStoreWorker] Failed to delete replaced vector store file', {
          fileId: replaceFileId,
          err: err?.message || err,
        });
      }
    }

    if (targetMint) {
      await updateTargetVectorStoreRecord({
        targetMint,
        vectorStoreId: resolvedStoreId,
        fileId: file.id,
      });
    }

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

async function updateTargetVectorStoreRecord({ targetMint, vectorStoreId, fileId }) {
  if (!targetMint) return;
  try {
    // Lazy-load BootyBox only when needed to avoid test DB initialization.
    const BootyBox = require('../../../db');
    const { ensureBootyBoxInit } = require('../../bootyBoxInit');
    await ensureBootyBoxInit();
    if (typeof BootyBox.updateTargetVectorStore === 'function') {
      BootyBox.updateTargetVectorStore(targetMint, {
        vectorStoreId,
        vectorStoreFileId: fileId,
        vectorStoreUpdatedAt: Date.now(),
      });
      return;
    }
    if (typeof BootyBox.addUpdateTarget === 'function') {
      BootyBox.addUpdateTarget({
        mint: targetMint,
        status: 'new',
        vectorStoreId,
        vectorStoreFileId: fileId,
        vectorStoreUpdatedAt: Date.now(),
        updatedAt: Date.now(),
        lastCheckedAt: Date.now(),
      });
    }
  } catch (err) {
    logger.warn('[vectorStoreWorker] Failed to persist target vector store fields', {
      targetMint,
      err: err?.message || err,
    });
  }
}

async function pruneVectorStoreFiles({
  vectorStoreId,
  prefix,
  olderThanSeconds,
  olderThanHours,
  dryRun,
  deleteFile,
  maxDeletes,
}) {
  const resolvedStoreId = vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;
  if (!resolvedStoreId) {
    logger.warn('[vectorStoreWorker] WARLORDAI_VECTOR_STORE missing; skipping prune');
    return { skipped: true, reason: 'missing_vector_store' };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[vectorStoreWorker] OPENAI_API_KEY missing; skipping prune');
    return { skipped: true, reason: 'missing_openai_key' };
  }

  const prefixes = normalizePrefixList(prefix);
  const maxDeletesNum = toPositiveNumber(maxDeletes);
  const olderThanSecondsNum = toPositiveNumber(olderThanSeconds);
  const olderThanHoursNum = toPositiveNumber(olderThanHours);
  const cutoffMs = Date.now() - (
    olderThanSecondsNum
      ? olderThanSecondsNum * 1000
      : (olderThanHoursNum ? olderThanHoursNum * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
  );
  const cutoffSec = Math.floor(cutoffMs / 1000);

  const openai = new OpenAI({ apiKey });
  const vectorStores = resolveVectorStoreClient(openai);
  if (!vectorStores?.files?.list) {
    throw new Error('Vector store list API not available on OpenAI client');
  }

  let scanned = 0;
  let oldEnough = 0;
  let matched = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  for await (const entry of vectorStores.files.list(resolvedStoreId, { limit: 100, order: 'desc' })) {
    scanned += 1;

    const createdAt = Number(entry?.created_at ?? entry?.createdAt ?? 0);
    if (Number.isFinite(createdAt) && createdAt > cutoffSec) {
      continue;
    }
    if (Number.isFinite(createdAt) && createdAt > 0) {
      oldEnough += 1;
    }

    const fileId = entry?.file_id || entry?.fileId || entry?.id || null;
    if (!fileId) {
      skipped += 1;
      continue;
    }

    let isMatch = matchesPrefix(entry?.attributes?.source, prefixes);
    let filename = null;

    if (!isMatch) {
      try {
        const fileObj = await openai.files.retrieve(fileId);
        filename = fileObj?.filename || null;
      } catch (err) {
        errors += 1;
        logger.warn('[vectorStoreWorker] prune failed to retrieve file metadata', {
          fileId,
          err: err?.message || err,
        });
        continue;
      }

      isMatch = matchesPrefix(filename, prefixes);
    }

    if (!isMatch) {
      skipped += 1;
      continue;
    }

    matched += 1;
    logger.debug('[vectorStoreWorker] prune match', {
      vectorStoreId: resolvedStoreId,
      fileId,
      filename,
      createdAt,
      dryRun: Boolean(dryRun),
    });

    if (dryRun) {
      if (maxDeletesNum && matched >= maxDeletesNum) break;
      continue;
    }

    try {
      await vectorStores.files.delete(fileId, { vector_store_id: resolvedStoreId });
      if (deleteFile && openai.files?.delete) {
        await openai.files.delete(fileId);
      }
      deleted += 1;
    } catch (err) {
      errors += 1;
      logger.warn('[vectorStoreWorker] prune delete failed', { fileId, err: err?.message || err });
    }

    if (maxDeletesNum && deleted >= maxDeletesNum) break;
  }

  const summary = {
    vectorStoreId: resolvedStoreId,
    dryRun: Boolean(dryRun),
    prefixes,
    cutoffSec,
    scanned,
    oldEnough,
    matched,
    deleted,
    skipped,
    errors,
  };

  logger.info('[vectorStoreWorker] prune complete', summary);
  return summary;
}

async function deleteVectorStoreFile({
  vectorStoreId,
  fileId,
  deleteFile,
  source,
  name,
  openai: openaiOverride,
}) {
  const resolvedStoreId = vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;
  if (!resolvedStoreId) {
    logger.warn('[vectorStoreWorker] WARLORDAI_VECTOR_STORE missing; skipping delete');
    return { skipped: true, reason: 'missing_vector_store', source };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[vectorStoreWorker] OPENAI_API_KEY missing; skipping delete');
    return { skipped: true, reason: 'missing_openai_key', source };
  }
  if (!fileId) {
    throw new Error('[vectorStoreWorker] fileId is required for delete');
  }

  const openai = openaiOverride || new OpenAI({ apiKey });
  const vectorStores = resolveVectorStoreClient(openai);
  if (!vectorStores?.files?.delete) {
    throw new Error('Vector store delete API not available on OpenAI client');
  }

  await vectorStores.files.delete(fileId, { vector_store_id: resolvedStoreId });
  logger.info('[vectorStoreWorker] Deleted vector store file', {
    vectorStoreId: resolvedStoreId,
    fileId,
    source,
    name,
  });

  if (deleteFile && openai.files?.delete) {
    await openai.files.delete(fileId);
    logger.info('[vectorStoreWorker] Deleted file object', { fileId, source, name });
  }

  return {
    vectorStoreId: resolvedStoreId,
    fileId,
    deleted: true,
    source,
    name,
  };
}

/**
 * Run the vector store upload worker.
 *
 * @param {VectorStoreWorkerPayload} payload
 * @returns {Promise<Object>}
 */
async function runVectorStoreWorker(payload) {
  const normalized = validateVectorStorePayload(payload);
  if (normalized.action === 'delete') {
    return deleteVectorStoreFile(normalized);
  }
  if (normalized.action === 'prune') {
    return pruneVectorStoreFiles(normalized);
  }
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
  if (payload?.attributes && typeof payload.attributes === 'object') out.attributes = payload.attributes;
  if (payload?.jsonPath) out.jsonPath = String(payload.jsonPath).trim();
  if (payload?.cleanupPath) out.cleanupPath = Boolean(payload.cleanupPath);
  if (payload?.action) out.action = String(payload.action).trim().toLowerCase();
  if (payload?.fileId) out.fileId = String(payload.fileId).trim();
  if (payload?.deleteFile != null) out.deleteFile = Boolean(payload.deleteFile);
  if (payload?.targetMint) out.targetMint = String(payload.targetMint).trim();
  if (payload?.replaceFileId) out.replaceFileId = String(payload.replaceFileId).trim();
  if (payload?.replaceVectorStoreId) out.replaceVectorStoreId = String(payload.replaceVectorStoreId).trim();
  if (payload?.deleteReplacedFile != null) out.deleteReplacedFile = Boolean(payload.deleteReplacedFile);
  if (payload?.prefix != null) out.prefix = payload.prefix;
  if (payload?.olderThanSeconds != null) out.olderThanSeconds = Number(payload.olderThanSeconds);
  if (payload?.olderThanHours != null) out.olderThanHours = Number(payload.olderThanHours);
  if (payload?.dryRun != null) out.dryRun = Boolean(payload.dryRun);
  if (payload?.maxDeletes != null) out.maxDeletes = Number(payload.maxDeletes);
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
