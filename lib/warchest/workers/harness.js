'use strict';

const fs = require('fs');
const path = require('path');
const { fork, spawn } = require('child_process');
const crypto = require('crypto');

const logger = require('../../logger');
const { redactSensitiveData } = require('../../logging/redaction');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_DIR = path.join(process.cwd(), 'data', 'warchest', 'locks');
const DEFAULT_PAYLOAD_DIR = path.join(process.cwd(), 'data', 'warchest', 'worker-payloads');

function safeSerializePayload(payload) {
  try {
    const scrubbed = redactSensitiveData(payload);
    return JSON.parse(JSON.stringify(scrubbed));
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
  const log = loggerInstance || (typeof logger.worker === 'function' ? logger.worker() : logger);
  const name = workerName || 'worker';
  const txMonitorQuiet = name === 'txMonitor' && !isTxMonitorVerbose();
  const metrics = typeof metricsReporter === 'function' ? metricsReporter : null;
  const defaultInfoLevel =
    process.env.WORKER_LOG_LEVEL || 'info';

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

  // Prefer explicit opts, but fall back to the "real" SolanaTracker env vars when present.
  const resolvedRpcEndpoint =
    (typeof rpcEndpoint === 'string' && rpcEndpoint.trim())
      ? rpcEndpoint.trim()
      : (typeof process.env.SOLANATRACKER_RPC_HTTP_URL === 'string' && process.env.SOLANATRACKER_RPC_HTTP_URL.trim())
        ? process.env.SOLANATRACKER_RPC_HTTP_URL.trim()
        : (typeof process.env.WARCHEST_RPC_ENDPOINT === 'string' && process.env.WARCHEST_RPC_ENDPOINT.trim())
          ? process.env.WARCHEST_RPC_ENDPOINT.trim()
          : null;

  const resolvedDataEndpoint =
    (typeof dataEndpoint === 'string' && dataEndpoint.trim())
      ? dataEndpoint.trim()
      : (typeof process.env.SOLANATRACKER_URL === 'string' && process.env.SOLANATRACKER_URL.trim())
        ? process.env.SOLANATRACKER_URL.trim()
        : (typeof process.env.SOLANATRACKER_DATA_ENDPOINT === 'string' && process.env.SOLANATRACKER_DATA_ENDPOINT.trim())
          ? process.env.SOLANATRACKER_DATA_ENDPOINT.trim()
          : (typeof process.env.WARCHEST_DATA_ENDPOINT === 'string' && process.env.WARCHEST_DATA_ENDPOINT.trim())
            ? process.env.WARCHEST_DATA_ENDPOINT.trim()
            : null;

  // Always provide Scoundrel-standard aliases for workers.
  if (resolvedRpcEndpoint) {
    env.WARCHEST_RPC_ENDPOINT = resolvedRpcEndpoint;
  }
  if (resolvedDataEndpoint) {
    env.WARCHEST_DATA_ENDPOINT = resolvedDataEndpoint;
  }

  // Also propagate the "real" SolanaTracker variables to child workers when we can.
  // (Workers merge `process.env` already, but this ensures consistency when using `extraEnv` overrides.)
  if (resolvedRpcEndpoint && !env.SOLANATRACKER_RPC_HTTP_URL) {
    env.SOLANATRACKER_RPC_HTTP_URL = resolvedRpcEndpoint;
  }
  if (resolvedDataEndpoint && !env.SOLANATRACKER_URL) {
    env.SOLANATRACKER_URL = resolvedDataEndpoint;
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
 * Spawn a detached worker process with a payload file argument.
 *
 * @param {string} workerPath
 * @param {Object} options
 * @param {Object} options.payload
 * @param {Object} [options.env]
 * @param {string} [options.payloadFileDir]
 * @param {string} [options.payloadFilePrefix]
 * @returns {{ pid: number, payloadFile: string }}
 */
function spawnWorkerDetached(workerPath, options = {}) {
  const { payload, env, payloadFileDir, payloadFilePrefix } = options;
  if (!workerPath) {
    throw new Error('workerPath is required to spawn a detached worker.');
  }

  const dir = payloadFileDir || DEFAULT_PAYLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const suffix = crypto.randomUUID();
  const prefix = payloadFilePrefix || 'worker';
  const payloadFile = path.join(dir, `${prefix}-${suffix}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload || {}, null, 2), 'utf8');

  const child = spawn(process.execPath, [workerPath, '--payload-file', payloadFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(env || {}) },
  });
  child.unref();

  return { pid: child.pid, payloadFile };
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
 * @param {Function} [options.onProgress] - Optional callback invoked for worker progress/events (e.g. `{type:'progress'}` or custom event types like `sellOps:*`).
 * @param {string} [options.lockTag] - Optional coordination tag; when provided a PID file is written and removed after exit.
 * @param {string} [options.lockDir] - Directory for PID/lock files (defaults to data/warchest/locks).
 * @param {boolean} [options.captureOutput] - When true, pipe child stdout/stderr and write them to a log file instead of inheriting to the terminal.
 * @param {string} [options.outputDir] - Directory to write captured worker logs (defaults to data/warchest/worker-logs).
 * @returns {Promise<{ result: *, requestId: string, raw: object, outputPath?: string }>} Resolved worker result.
 */
function forkWorkerWithPayload(workerPath, options) {
  const {
    payload,
    timeoutMs,
    env,
    requestId: explicitRequestId,
    lockTag,
    lockDir,
    onProgress,
    captureOutput,
    outputDir,
    waitForExit: explicitWaitForExit,
  } = options || {};
  const requestId = explicitRequestId || crypto.randomBytes(8).toString('hex');
  const childEnv = { ...process.env, ...env };
  const resolvedOutputDir = outputDir || path.join(process.cwd(), 'data', 'warchest', 'worker-logs');
  const workerTag = path.basename(workerPath).replace(/\.js$/i, '');
  const outputPath = captureOutput
    ? path.join(resolvedOutputDir, `${workerTag}-${requestId}.log`)
    : null;
  const cleanupFns = [];
  const lock = lockTag ? createPidTag(lockTag, lockDir) : null;
  let pendingExitResult = null;
  let exitWaitHandle = null;

  // Default behavior: short-lived workers should exit after responding.
  // For long-running workers that stream HUD updates via `onProgress`, we should resolve on result
  // without requiring the worker process to exit.
  const waitForExit = typeof explicitWaitForExit === 'boolean'
    ? explicitWaitForExit
    : (typeof onProgress === 'function' ? false : true);

  if (lock) {
    cleanupFns.push(() => lock.release());
  }

  const child = fork(workerPath, [], {
    stdio: captureOutput ? ['inherit', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'],
    env: childEnv,
  });

  let outputStream = null;
  if (captureOutput) {
    try {
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
      outputStream = fs.createWriteStream(outputPath, { flags: 'a' });
      cleanupFns.push(() => {
        try {
          if (outputStream) outputStream.end();
        } catch (e) {
          // ignore
        }
      });

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          try {
            outputStream.write(chunk);
          } catch (e) {
            // ignore
          }
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          try {
            outputStream.write(chunk);
          } catch (e) {
            // ignore
          }
        });
      }
    } catch (err) {
      // If we fail to capture output, fall back silently (Ink will still be best-effort).
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    function removeListeners() {
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (exitWaitHandle) clearTimeout(exitWaitHandle);
    }

    const effectiveTimeoutMs = timeoutMs == null ? DEFAULT_TIMEOUT_MS : timeoutMs;

    const timeoutHandle = effectiveTimeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          removeListeners();
          cleanupFns.forEach((fn) => fn());
          reject(new Error(`Worker timed out after ${effectiveTimeoutMs}ms`));
        }, effectiveTimeoutMs)
      : null;

    function finish(err, res) {
      if (settled) return;
      settled = true;
      removeListeners();
      cleanupFns.forEach((fn) => fn());
      if (outputPath) {
        try {
          const stat = fs.statSync(outputPath);
          if (stat.size === 0) {
            fs.unlinkSync(outputPath);
          }
        } catch (_) {
          // ignore missing/cleanup errors
        }
      }
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    }

    function onMessage(msg) {
      if (!msg) return;

      // Forward progress/custom event messages to the caller even if they don't include requestId.
      // This is used by long-running workers that stream HUD updates.
      const isProgressLike = msg.type === 'progress' || (typeof msg.type === 'string' && msg.type.startsWith('sellOps:'));
      if (isProgressLike) {
        if (typeof onProgress === 'function') {
          try {
            // Preserve the full message shape so callers can route by `type`.
            onProgress(msg);
          } catch (err) {
            // progress callbacks must never crash the worker harness
          }
        }
        // Only gate further handling on requestId; custom events may omit it.
        if (msg.type === 'progress') {
          // progress messages are tied to a request
          return;
        }
        // For custom events, fall through only if requestId matches; otherwise ignore for result/error.
      }

      if (!msg.requestId || msg.requestId !== requestId) return;
      if (msg.type === 'result') {
        pendingExitResult = { result: msg.payload, requestId, raw: msg, outputPath };
      } else if (msg.type === 'error') {
        const err = new Error(msg.payload && msg.payload.message ? msg.payload.message : 'Worker error');
        err.stack = msg.payload && msg.payload.stack ? msg.payload.stack : err.stack;
        pendingExitResult = err;
      }

      if (pendingExitResult && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      // If we aren't waiting for exit (streaming/daemon workers), resolve immediately on response.
      if (pendingExitResult && !waitForExit) {
        if (pendingExitResult instanceof Error) {
          finish(pendingExitResult);
        } else {
          finish(null, pendingExitResult);
        }
        return;
      }

      // Otherwise, require the worker to exit shortly after responding.
      if (pendingExitResult && waitForExit && !exitWaitHandle) {
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
  const lifecycle = createLifecycleLogger(workerName, null, metricsReporter);
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
    if (requestId != null) {
      process.env.SC_WORKER_REQUEST_ID = String(requestId);
    }

    lifecycle.start(requestId, payload);

    try {
      const progress = (event, data) => {
        if (typeof process.send !== 'function') return;
        process.send({
          type: 'progress',
          payload: { event, data: data === undefined ? null : data, ts: Date.now() },
          requestId,
        });
      };
      const result = await handler(payload, { track, requestId, env: process.env, progress });
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
  spawnWorkerDetached,
};
