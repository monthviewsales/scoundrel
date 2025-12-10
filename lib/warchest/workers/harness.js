'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_DIR = path.join(process.cwd(), 'data', 'warchest', 'locks');

/**
 * Build environment variables that a worker can rely on for SolanaTracker/BootyBox access.
 *
 * @param {Object} opts
 * @param {string} [opts.rpcEndpoint] - SolanaTracker RPC endpoint URL.
 * @param {string} [opts.dataEndpoint] - SolanaTracker Data API endpoint URL.
 * @param {number|number[]|string} [opts.walletIds] - Wallet IDs to hydrate in the worker (stored as comma-delimited env).
 * @param {string} [opts.bootyBoxPath] - Optional BootyBox DB/adapter path for workers that need to open BootyBox directly.
 * @param {Object} [opts.extraEnv] - Extra env vars to pass through to the worker.
 * @returns {Object} Environment variables safe to spread into `fork`'s `env` option.
 */
function buildWorkerEnv(opts) {
  const { rpcEndpoint, dataEndpoint, walletIds, bootyBoxPath, extraEnv } = opts || {};
  const env = { ...extraEnv };

  if (rpcEndpoint) {
    env.WARCHEST_RPC_ENDPOINT = rpcEndpoint;
  }
  if (dataEndpoint) {
    env.WARCHEST_DATA_ENDPOINT = dataEndpoint;
  }
  if (walletIds != null) {
    const ids = Array.isArray(walletIds) ? walletIds.join(',') : String(walletIds);
    env.WARCHEST_WALLET_IDS = ids;
  }
  if (bootyBoxPath) {
    env.WARCHEST_BOOTYBOX_PATH = bootyBoxPath;
  }

  return env;
}

/**
 * Create or reuse a pid/tag file for lightweight worker coordination.
 * Throws if the tag already exists.
 *
 * @param {string} tag - A unique key describing the worker (e.g., `coinMonitor-<mint>`).
 * @param {string} [dir] - Directory for pid/tag files.
 * @returns {{path:string, release:Function}} Handle for releasing the tag.
 */
function createPidTag(tag, dir) {
  if (!tag) {
    throw new Error('A non-empty tag is required to create a PID file.');
  }

  const lockDir = dir || DEFAULT_LOCK_DIR;
  const lockPath = path.join(lockDir, `${tag}.json`);

  if (fs.existsSync(lockPath)) {
    const existing = fs.readFileSync(lockPath, 'utf8');
    throw new Error(`PID tag already exists for ${tag}: ${existing}`);
  }

  fs.mkdirSync(lockDir, { recursive: true });
  const payload = { pid: process.pid, tag, ts: Date.now() };
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), 'utf8');

  return {
    path: lockPath,
    release() {
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch (err) {
        // Best effort cleanup; surface issues to callers so tests can assert on them if needed.
        throw err;
      }
    },
  };
}

/**
 * Fork a worker, send it a `{ type, payload, requestId }` envelope, and resolve on response.
 * Handles timeouts and ensures the child/lock are cleaned up.
 *
 * @param {string} workerPath - Absolute path to the worker module to fork.
 * @param {Object} options
 * @param {Object} options.payload - Arbitrary payload passed over IPC.
 * @param {string} [options.requestId] - Optional request identifier; a random value is used when omitted.
 * @param {number} [options.timeoutMs] - Milliseconds to wait before killing the worker.
 * @param {Object} [options.env] - Additional env vars to merge into the child process.
 * @param {string} [options.lockTag] - Optional coordination tag; when provided a PID file is written and removed after exit.
 * @param {string} [options.lockDir] - Directory for PID/lock files (defaults to data/warchest/locks).
 * @returns {Promise<{ result: *, requestId: string, raw: object }>} Resolved worker result.
 */
function forkWorkerWithPayload(workerPath, options) {
  const { payload, timeoutMs, env, requestId: explicitRequestId, lockTag, lockDir } = options || {};
  const requestId = explicitRequestId || crypto.randomBytes(8).toString('hex');
  const childEnv = { ...process.env, ...env };
  const cleanupFns = [];
  const lock = lockTag ? createPidTag(lockTag, lockDir) : null;

  if (lock) {
    cleanupFns.push(() => lock.release());
  }

  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: childEnv,
    });

    let settled = false;

    function removeListeners() {
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      removeListeners();
      cleanupFns.forEach((fn) => fn());
      reject(new Error(`Worker timed out after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    function finish(err, res) {
      if (settled) return;
      settled = true;
      removeListeners();
      cleanupFns.forEach((fn) => fn());
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    }

    function onMessage(msg) {
      if (!msg || msg.requestId !== requestId) return;
      if (msg.type === 'result') {
        finish(null, { result: msg.payload, requestId, raw: msg });
      } else if (msg.type === 'error') {
        const err = new Error(msg.payload && msg.payload.message ? msg.payload.message : 'Worker error');
        err.stack = msg.payload && msg.payload.stack ? msg.payload.stack : err.stack;
        finish(err);
      }
    }

    function onExit(code, signal) {
      if (settled) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(new Error(`Worker exited before responding (${reason})`));
    }

    function onError(err) {
      if (settled) return;
      finish(err);
    }

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);

    child.send({ type: 'start', payload, requestId });
  });
}

/**
 * Create a worker-side harness that listens for `{ type: 'start', payload, requestId }` messages
 * and responds with `{ type: 'result' | 'error', payload, requestId }`.
 * Cleanups include `close()`/`unsubscribe()` resources and process listeners.
 *
 * @param {Function} handler - Async function receiving `(payload, tools)` and returning a result.
 * @param {Object} [options]
 * @param {boolean} [options.exitOnComplete=true] - Whether to exit after sending the result.
 * @param {Function} [options.onClose] - Optional hook invoked after tracked resources close.
 * @returns {void}
 */
function createWorkerHarness(handler, options) {
  const { exitOnComplete = true, onClose } = options || {};
  const cleanupResources = new Set();
  let cleaned = false;

  function track(resource) {
    if (resource) cleanupResources.add(resource);
    return resource;
  }

  async function runCleanup() {
    if (cleaned) return;
    cleaned = true;

    for (const resource of cleanupResources) {
      // Prefer close() when available, then unsubscribe() for subscriptions.
      if (resource && typeof resource.close === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await resource.close();
      }
      if (resource && typeof resource.unsubscribe === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await resource.unsubscribe();
      }
    }
    cleanupResources.clear();

    if (typeof onClose === 'function') {
      await onClose();
    }

    process.removeListener('message', onMessage);
    process.removeListener('disconnect', onDisconnect);
    process.removeListener('SIGINT', onSigint);
  }

  async function handleResult(requestId, result) {
    if (typeof process.send === 'function') {
      process.send({ type: 'result', payload: result, requestId });
    }
    if (exitOnComplete) {
      await runCleanup();
      process.exit(0);
    }
  }

  async function handleError(requestId, err) {
    const payload = {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined,
    };
    if (typeof process.send === 'function') {
      process.send({ type: 'error', payload, requestId });
    }
    if (exitOnComplete) {
      await runCleanup();
      process.exit(1);
    }
  }

  async function onMessage(msg) {
    if (!msg || msg.type !== 'start') return;
    const { payload, requestId } = msg;

    try {
      const result = await handler(payload, { track, requestId, env: process.env });
      await handleResult(requestId, result);
    } catch (err) {
      await handleError(requestId, err);
    }
  }

  async function onDisconnect() {
    await runCleanup();
    process.exit(0);
  }

  async function onSigint() {
    await runCleanup();
    process.exit(0);
  }

  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);
  process.once('SIGINT', onSigint);
}

module.exports = {
  buildWorkerEnv,
  createPidTag,
  createWorkerHarness,
  forkWorkerWithPayload,
};
