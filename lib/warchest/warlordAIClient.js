'use strict';

const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const baseLogger = require('../logger');

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @typedef {Object} WarlordAIClientOptions
 * @property {string} [workerPath]
 * @property {Object} [env]
 * @property {import('../logger')} [logger]
 * @property {string} [sessionId]
 * @property {string} [serviceInstanceId]
 */

/**
 * @typedef {Object} WarlordAIRequestOptions
 * @property {number} [timeoutMs]
 * @property {Function} [onProgress]
 */

/**
 * Create a long-lived WarlordAI worker client using IPC.
 *
 * @param {WarlordAIClientOptions} [options]
 * @returns {{ request: Function, close: Function, getSessionId: Function, pid: number|null }}
 */
function createWarlordAIClient(options = {}) {
  const workerPath = options.workerPath || path.join(__dirname, 'workers', 'warlordAIWorker.js');
  const logger = options.logger || baseLogger;
  const env = { ...process.env, ...(options.env || {}) };
  const serviceInstanceId = options.serviceInstanceId || null;
  let sessionId = options.sessionId || serviceInstanceId || null;

  const child = fork(workerPath, [], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env,
  });

  const pending = new Map();
  let closed = false;

  function resolveSessionDefaults(payload) {
    const out = { ...(payload || {}) };
    if (serviceInstanceId && out.serviceInstanceId == null) {
      out.serviceInstanceId = serviceInstanceId;
    }
    if (sessionId && out.sessionId == null) {
      out.sessionId = sessionId;
    }
    return out;
  }

  function finalizePending(err) {
    for (const entry of pending.values()) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleMessage(msg) {
    if (!msg || !msg.requestId) return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;

    if (msg.type === 'progress') {
      if (typeof entry.onProgress === 'function') {
        try {
          entry.onProgress(msg.payload);
        } catch (_) {
          // progress handler errors should not break the worker client
        }
      }
      return;
    }

    pending.delete(msg.requestId);
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);

    if (msg.type === 'result') {
      if (!sessionId && msg.payload && msg.payload.sessionId) {
        sessionId = msg.payload.sessionId;
      }
      entry.resolve(msg.payload);
      return;
    }

    if (msg.type === 'error') {
      const err = new Error(msg.payload && msg.payload.message ? msg.payload.message : 'Worker error');
      err.stack = msg.payload && msg.payload.stack ? msg.payload.stack : err.stack;
      entry.reject(err);
    }
  }

  function handleExit(code, signal) {
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    finalizePending(new Error(`WarlordAI worker exited (${reason})`));
  }

  function handleError(err) {
    finalizePending(err || new Error('WarlordAI worker error'));
  }

  child.on('message', handleMessage);
  child.once('exit', handleExit);
  child.once('error', handleError);

  /**
   * Send a request to the WarlordAI worker.
   *
   * @param {Object} payload
   * @param {WarlordAIRequestOptions} [requestOptions]
   * @returns {Promise<any>}
   */
  function request(payload, requestOptions = {}) {
    if (closed) {
      return Promise.reject(new Error('WarlordAI worker client is closed'));
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timeoutMs = Number.isFinite(requestOptions.timeoutMs)
      ? Math.max(1, Math.trunc(requestOptions.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const normalizedPayload = resolveSessionDefaults(payload);

    return new Promise((resolve, reject) => {
      const timeoutHandle = timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`WarlordAI request timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      pending.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
        onProgress: requestOptions.onProgress,
      });

      try {
        child.send({ type: 'start', payload: normalizedPayload, requestId });
      } catch (err) {
        pending.delete(requestId);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      }
    });
  }

  /**
   * Close the worker client and terminate the child process.
   *
   * @returns {void}
   */
  function close() {
    if (closed) return;
    closed = true;
    try {
      child.removeListener('message', handleMessage);
      child.removeListener('exit', handleExit);
      child.removeListener('error', handleError);
      child.kill();
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[warlordAIClient] Failed to close worker', err?.message || err);
      }
    } finally {
      finalizePending(new Error('WarlordAI worker client closed'));
    }
  }

  return {
    request,
    close,
    getSessionId: () => sessionId,
    pid: child.pid || null,
  };
}

module.exports = { createWarlordAIClient };
