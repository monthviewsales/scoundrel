'use strict';

const path = require('path');
const EventEmitter = require('events');

const { buildWorkerEnv, forkWorkerWithPayload, spawnWorkerDetached } = require('./workers/harness');
const { appendHubEvent, DEFAULT_EVENT_PATH, DEFAULT_STATUS_PATH } = require('./events');
const { writeStatusSnapshot } = require('./client');

const DEFAULT_SWAP_WORKER = path.join(__dirname, 'workers', 'swapWorker.js');
const DEFAULT_TX_MONITOR_WORKER = path.join(__dirname, 'workers', 'txMonitorWorker.js');
const DEFAULT_TARGET_LIST_WORKER = path.join(__dirname, 'workers', 'targetListWorker.js');

function namespaceFor(command, payload) {
  if (command === 'swap') {
    const walletKey = payload.walletAlias || payload.walletId || payload.wallet || payload.walletPrivateKey || 'wallet';
    return `wallet:${walletKey}`;
  }
  if (command === 'txMonitor') {
    return `tx:${payload.txid}`;
  }
  if (command === 'targetList') {
    return 'targetList';
  }
  return command;
}

/**
 * Create a lightweight coordinator that routes hub commands through the worker harness.
 *
 * @param {Object} [options]
 * @param {string} [options.swapWorkerPath]
 * @param {string} [options.txMonitorWorkerPath]
 * @param {string} [options.targetListWorkerPath]
 * @param {string} [options.statusPath]
 * @param {string} [options.eventPath]
 * @param {Object} [options.env]
 * @param {Object} [options.commandEnv]
 * @param {string} [options.lockPrefix]
 * @param {boolean} [options.attachSignals=true]
 * @returns {{runSwap:Function,runTxMonitor:Function,runTargetList:Function,publishStatus:Function,publishHudEvent:Function,close:Function,on:Function,once:Function,paths:Object}}
 */
function createHubCoordinator(options = {}) {
  const emitter = new EventEmitter();
  const active = new Map();
  const closeHandlers = new Set();

  const swapWorkerPath = options.swapWorkerPath || DEFAULT_SWAP_WORKER;
  const txMonitorWorkerPath = options.txMonitorWorkerPath || DEFAULT_TX_MONITOR_WORKER;
  const targetListWorkerPath = options.targetListWorkerPath || DEFAULT_TARGET_LIST_WORKER;
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const eventPath = options.eventPath || DEFAULT_EVENT_PATH;
  const envBase = options.env || {};
  const commandEnv = options.commandEnv || {};

  async function runWorker(command, payload, runOptions = {}) {
    const ns = namespaceFor(command, payload || {});
    if (active.has(ns)) {
      throw new Error(`Command already running for namespace ${ns}`);
    }

    const workerPath =
      runOptions.workerPath ||
      (command === 'txMonitor'
        ? txMonitorWorkerPath
        : command === 'targetList'
          ? targetListWorkerPath
          : swapWorkerPath);
    const envInput = { ...envBase, ...(commandEnv[command] || {}) };
    const env = runOptions.env || buildWorkerEnv({ ...envInput, extraEnv: envInput });
    const lockTag = runOptions.lockTag || (options.lockPrefix ? `${options.lockPrefix}-${ns}` : ns);

    emitter.emit('start', { command, namespace: ns, payload });

    const runDetached = runOptions.detached === true;
    let workerPromise = null;
    const runPromise = runDetached
      ? Promise.resolve().then(() => {
          const detached = spawnWorkerDetached(workerPath, {
            payload,
            env,
            payloadFilePrefix: `${command}`,
            payloadFileDir: runOptions.payloadFileDir,
          });
          const result = { detached: true, ...detached };
          emitter.emit('result', { command, namespace: ns, result });
          return result;
        })
      : (() => {
          workerPromise = forkWorkerWithPayload(workerPath, {
            payload,
            env,
            lockTag,
            timeoutMs: runOptions.timeoutMs,
            captureOutput: runOptions.captureOutput,
            onProgress: runOptions.onProgress,
          });
          return workerPromise.then((res) => {
            const result = res && res.result ? res.result : res;
            emitter.emit('result', { command, namespace: ns, result });
            return result;
          });
        })();

    const promise = runPromise
      .catch((err) => {
        emitter.emit('error', { command, namespace: ns, error: err });
        throw err;
      })
      .finally(() => {
        active.delete(ns);
      });

    if (workerPromise) {
      promise.stop = workerPromise.stop;
      promise.child = workerPromise.child;
      promise.pid = workerPromise.pid;
    }

    active.set(ns, promise);
    return promise;
  }

  function publishStatus(status) {
    if (!status) return;
    writeStatusSnapshot(status, path.dirname(statusPath));
    emitter.emit('status', status);
  }

  function publishHudEvent(event) {
    appendHubEvent(event, eventPath);
    emitter.emit('hud:event', event);
  }

  function close() {
    closeHandlers.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore shutdown errors
      }
    });
    closeHandlers.clear();
    emitter.removeAllListeners();
    active.clear();
  }

  if (options.attachSignals !== false) {
    const onSignal = () => close();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    closeHandlers.add(() => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    });
  }

  return {
    runSwap: (payload, runOptions) => runWorker('swap', payload, runOptions),
    runTxMonitor: (payload, runOptions) => runWorker('txMonitor', payload, runOptions),
    runTargetList: (payload, runOptions) => runWorker('targetList', payload, runOptions),
    publishStatus,
    publishHudEvent,
    on: (...args) => emitter.on(...args),
    once: (...args) => emitter.once(...args),
    close,
    paths: { statusPath, eventPath },
  };
}

module.exports = {
  createHubCoordinator,
};
