'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const crypto = require('crypto');

const logger = require('../../logger');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_DIR = path.join(process.cwd(), 'data', 'warchest', 'locks');

function safeSerializePayload(payload) {
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch (err) {
    return '[unserializable payload]';
  }
}

function isTxMonitorVerbose() {
  return (
    process.env.TX_MONITOR_VERBOSE === '1' ||
    process.env.TX_MONITOR_DEBUG === '1' ||
    process.env.SAW_RAW === '1'
  );
}

function pickTxMonitorBrief(payloadOrResult) {
  if (!payloadOrResult || typeof payloadOrResult !== 'object') return {};
  const txid = payloadOrResult.txid || payloadOrResult.signature || null;
  const status = payloadOrResult.status || null;
  const mint = payloadOrResult.mint || null;
  const side = payloadOrResult.side || null;
  const wallet = payloadOrResult.wallet || payloadOrResult.walletAddress || null;

  return {
    ...(txid ? { txid } : {}),
    ...(status ? { status } : {}),
    ...(wallet ? { wallet } : {}),
    ...(mint ? { mint } : {}),
    ...(side ? { side } : {}),
  };
}

/**
 * Build a structured lifecycle logger for a worker.
 *
 * @param {string} workerName
 * @param {import('../../logger')} loggerInstance
 * @param {Function} [metricsReporter]
 * @returns {{start:Function,success:Function,error:Function,cleanup:Function}}
 */
function createLifecycleLogger(workerName, loggerInstance, metricsReporter) {
  const log = loggerInstance || logger;
  const name = workerName || 'worker';
  const txMonitorQuiet = name === 'txMonitor' && !isTxMonitorVerbose();
  const metrics = typeof metricsReporter === 'function' ? metricsReporter : null;
  const defaultInfoLevel =
    process.env.WORKER_LOG_LEVEL ||
    (process.env.NODE_ENV === 'production' ? 'debug' : 'info');

  function emit(level, event, requestId, extra) {
    const actualLevel = level === 'info' ? defaultInfoLevel : level;
    const payload = {
      worker: name,
      event,
      requestId,
      ...extra,
    };

    if (log && typeof log[actualLevel] === 'function') {
      const serialized = safeSerializePayload(payload);
      log[actualLevel](`[${name}] ${event} ${JSON.stringify(serialized)}`);
    }

    if (metrics) {
      metrics(payload);
    }
  }

  return {
    start(requestId, payload) {
      const body = txMonitorQuiet ? pickTxMonitorBrief(payload) : safeSerializePayload(payload);
      // For quiet txMonitor logs, keep payload flat and small.
      emit('info', 'start', requestId, { payload: body });
    },
    success(requestId, result, startedAt) {
      const durationMs = startedAt ? Date.now() - startedAt : null;
      const body = txMonitorQuiet ? pickTxMonitorBrief(result) : safeSerializePayload(result);
      emit('info', 'success', requestId, {
        durationMs,
        result: body,
      });
    },
    error(requestId, err, startedAt) {
      const durationMs = startedAt ? Date.now() - startedAt : null;
      emit('error', 'error', requestId, {
        durationMs,
        error: err && err.message ? err.message : String(err),
      });
    },
    cleanup(requestId) {
      // Cleanup events can be noisy for txMonitor; keep them in debug unless explicitly verbose.
      const level = txMonitorQuiet ? 'debug' : 'info';
      emit(level, 'cleanup', requestId, {});
    },
  };
}

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
  let pendingExitResult = null;
  let exitWaitHandle = null;

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
      if (exitWaitHandle) clearTimeout(exitWaitHandle);
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
        pendingExitResult = { result: msg.payload, requestId, raw: msg };
      } else if (msg.type === 'error') {
        const err = new Error(msg.payload && msg.payload.message ? msg.payload.message : 'Worker error');
        err.stack = msg.payload && msg.payload.stack ? msg.payload.stack : err.stack;
        pendingExitResult = err;
      }

      if (pendingExitResult && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (pendingExitResult && !exitWaitHandle) {
        exitWaitHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          removeListeners();
          cleanupFns.forEach((fn) => fn());
          reject(new Error('Worker did not exit after sending response'));
        }, 5000);
      }
    }

    function onExit(code, signal) {
      if (pendingExitResult) {
        if (pendingExitResult instanceof Error) {
          finish(pendingExitResult);
        } else {
          finish(null, pendingExitResult);
        }
        return;
      }
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
 * @param {string} [options.workerName] - Name used for structured lifecycle logging.
 * @param {import('../../logger')} [options.logger] - Logger to emit lifecycle events to.
 * @param {Function} [options.metricsReporter] - Optional metrics hook invoked with lifecycle payloads.
 * @returns {void}
 */
function createWorkerHarness(handler, options) {
  const { exitOnComplete = true, onClose, workerName, logger: loggerInstance, metricsReporter } = options || {};
  const cleanupResources = new Set();
  let cleaned = false;
  const lifecycle = createLifecycleLogger(workerName, loggerInstance, metricsReporter);
  let currentRequestId = null;

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

    lifecycle.cleanup(currentRequestId);

    process.removeListener('message', onMessage);
    process.removeListener('disconnect', onDisconnect);
    process.removeListener('SIGINT', onSigint);
  }

  async function handleResult(requestId, result, startedAt) {
    lifecycle.success(requestId, result, startedAt);
    if (typeof process.send === 'function') {
      process.send({ type: 'result', payload: result, requestId });
    }
    if (exitOnComplete) {
      await runCleanup();
      process.exit(0);
    }
  }

  async function handleError(requestId, err, startedAt) {
    lifecycle.error(requestId, err, startedAt);
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
    currentRequestId = requestId;
    const startedAt = Date.now();

    lifecycle.start(requestId, payload);

    try {
      const result = await handler(payload, { track, requestId, env: process.env });
      await handleResult(requestId, result, startedAt);
    } catch (err) {
      await handleError(requestId, err, startedAt);
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
  createLifecycleLogger,
  forkWorkerWithPayload,
};
