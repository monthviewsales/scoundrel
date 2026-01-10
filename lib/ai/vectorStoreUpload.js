'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnWorkerDetached } = require('../warchest/workers/harness');
const logger = require('../logger').child({ scope: 'vectorStoreUpload' });

/**
 * @typedef {Object} VectorStoreUploadRequest
 * @property {string} [source] - Logical source label (autopsy, dossier, targetscan, etc.).
 * @property {string} [vectorStoreId] - Override vector store id (defaults to WARLORDAI_VECTOR_STORE).
 * @property {string} [jsonPath] - Path to a JSON file to upload.
 * @property {Object|string} [data] - JSON object or JSON string to upload when jsonPath is not provided.
 * @property {string} [name] - Optional label for logging.
 */

function sanitizePrefix(value) {
  return String(value || 'upload')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'upload';
}

/**
 * Queue a vector store upload using the shared worker.
 *
 * @param {VectorStoreUploadRequest} params
 * @returns {Promise<{ queued: boolean, reason?: string, pid?: number, payloadFile?: string, jsonPath?: string }>}
 */
async function queueVectorStoreUpload(params = {}) {
  const vectorStoreId = params.vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;
  if (!vectorStoreId) {
    logger.debug('[vectorStoreUpload] WARLORDAI_VECTOR_STORE not set; skipping upload');
    return { queued: false, reason: 'missing_vector_store' };
  }
  if (!process.env.OPENAI_API_KEY) {
    logger.debug('[vectorStoreUpload] OPENAI_API_KEY not set; skipping upload');
    return { queued: false, reason: 'missing_openai_key' };
  }

  const source = params.source ? String(params.source).trim() : 'upload';
  let jsonPath = params.jsonPath ? String(params.jsonPath) : null;
  let cleanupPath = false;

  if (!jsonPath) {
    const payload = params.data;
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    const filename = `warlordai-${sanitizePrefix(source)}-${randomUUID()}.json`;
    jsonPath = path.join(os.tmpdir(), filename);
    await fs.promises.writeFile(jsonPath, content, 'utf8');
    cleanupPath = true;
  }

  const workerPath = path.join(__dirname, '..', 'warchest', 'workers', 'vectorStoreWorker.js');
  const { pid, payloadFile } = spawnWorkerDetached(workerPath, {
    payload: {
      vectorStoreId,
      source,
      name: params.name || null,
      jsonPath,
      cleanupPath,
    },
    payloadFilePrefix: `vector-${sanitizePrefix(source)}`,
  });

  return {
    queued: true,
    pid,
    payloadFile,
    jsonPath,
  };
}

module.exports = { queueVectorStoreUpload };
