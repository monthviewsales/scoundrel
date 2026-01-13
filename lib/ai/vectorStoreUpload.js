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
 * @property {Object} [attributes] - Optional vector store attributes for filtering.
 * @property {string} [targetMint] - Optional mint to persist vector store ids to sc_targets.
 * @property {string} [replaceFileId] - Optional prior file id to delete after upload.
 * @property {string} [replaceVectorStoreId] - Vector store id for the prior file (defaults to vectorStoreId).
 * @property {boolean} [deleteReplacedFile] - Whether to delete the underlying file object.
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
      action: 'upload',
      vectorStoreId,
      source,
      name: params.name || null,
      attributes: params.attributes && typeof params.attributes === 'object' ? params.attributes : null,
      jsonPath,
      cleanupPath,
      targetMint: params.targetMint || null,
      replaceFileId: params.replaceFileId || null,
      replaceVectorStoreId: params.replaceVectorStoreId || null,
      deleteReplacedFile: params.deleteReplacedFile === true,
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

/**
 * Queue a vector store delete using the shared worker.
 *
 * @param {{ vectorStoreId?: string, fileId: string, deleteFile?: boolean, source?: string, name?: string }} params
 * @returns {Promise<{ queued: boolean, reason?: string, pid?: number, payloadFile?: string }>}
 */
async function queueVectorStoreDelete(params = {}) {
  const vectorStoreId = params.vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;
  if (!vectorStoreId) {
    logger.debug('[vectorStoreUpload] WARLORDAI_VECTOR_STORE not set; skipping delete');
    return { queued: false, reason: 'missing_vector_store' };
  }
  if (!process.env.OPENAI_API_KEY) {
    logger.debug('[vectorStoreUpload] OPENAI_API_KEY not set; skipping delete');
    return { queued: false, reason: 'missing_openai_key' };
  }

  const fileId = params.fileId ? String(params.fileId).trim() : '';
  if (!fileId) {
    return { queued: false, reason: 'missing_file_id' };
  }

  const source = params.source ? String(params.source).trim() : 'upload';
  const workerPath = path.join(__dirname, '..', 'warchest', 'workers', 'vectorStoreWorker.js');
  const { pid, payloadFile } = spawnWorkerDetached(workerPath, {
    payload: {
      action: 'delete',
      vectorStoreId,
      fileId,
      deleteFile: params.deleteFile === true,
      source,
      name: params.name || null,
    },
    payloadFilePrefix: `vector-delete-${sanitizePrefix(source)}`,
  });

  return {
    queued: true,
    pid,
    payloadFile,
  };
}

/**
 * Queue a vector store prune using the shared worker.
 *
 * @param {{ vectorStoreId?: string, prefix?: string|string[], olderThanSeconds?: number, olderThanHours?: number, dryRun?: boolean, deleteFile?: boolean, maxDeletes?: number }} params
 * @returns {Promise<{ queued: boolean, reason?: string, pid?: number, payloadFile?: string }>}
 */
async function queueVectorStorePrune(params = {}) {
  const vectorStoreId = params.vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;
  if (!vectorStoreId) {
    logger.debug('[vectorStoreUpload] WARLORDAI_VECTOR_STORE not set; skipping prune');
    return { queued: false, reason: 'missing_vector_store' };
  }
  if (!process.env.OPENAI_API_KEY) {
    logger.debug('[vectorStoreUpload] OPENAI_API_KEY not set; skipping prune');
    return { queued: false, reason: 'missing_openai_key' };
  }

  const workerPath = path.join(__dirname, '..', 'warchest', 'workers', 'vectorStoreWorker.js');
  const { pid, payloadFile } = spawnWorkerDetached(workerPath, {
    payload: {
      action: 'prune',
      vectorStoreId,
      prefix: params.prefix ?? null,
      olderThanSeconds: params.olderThanSeconds ?? null,
      olderThanHours: params.olderThanHours ?? null,
      dryRun: params.dryRun === true,
      deleteFile: params.deleteFile === true,
      maxDeletes: params.maxDeletes ?? null,
    },
    payloadFilePrefix: 'vector-prune',
  });

  return {
    queued: true,
    pid,
    payloadFile,
  };
}

module.exports = { queueVectorStoreUpload, queueVectorStoreDelete, queueVectorStorePrune };
