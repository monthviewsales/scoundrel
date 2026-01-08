'use strict';

const baseLogger = require('../../logger');
const { createWorkerHarness, safeSerializePayload } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');
const path = require('path');

const logger = createWorkerLogger({
  workerName: 'devscanWorker',
  scope: 'devscanWorker',
  baseLogger,
  includeCallsite: true,
});
const metricsLogger = typeof baseLogger.metrics === 'function'
  ? baseLogger.metrics()
  : baseLogger;

/**
 * @typedef {Object} DevscanWorkerPayload
 * @property {string} [mint] - Token mint address.
 * @property {string} [developerWallet] - Developer wallet address.
 * @property {string} [developerTokensWallet] - Developer wallet for token list lookup.
 * @property {boolean} [runAnalysis=true] - Whether to run OpenAI analysis.
 */

/** @typedef {import('../../cli/devscan').DevscanRunResult} DevscanWorkerResult */

function loadDevscanRunner() {
  if (process.env.DEVSCAN_WORKER_RUNNER) {
    const modPath = path.isAbsolute(process.env.DEVSCAN_WORKER_RUNNER)
      ? process.env.DEVSCAN_WORKER_RUNNER
      : path.join(process.cwd(), process.env.DEVSCAN_WORKER_RUNNER);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(modPath);
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.runDevscan === 'function') return mod.runDevscan;
    throw new Error('DEVSCAN_WORKER_RUNNER must export a function or runDevscan');
  }

  // eslint-disable-next-line global-require
  const { runDevscan } = require('../../cli/devscan');
  return runDevscan;
}

function buildDevscanMetricsPayload(event) {
  const details = event?.result || event?.payload || {};

  return {
    worker: event?.worker || 'devscanWorker',
    event: event?.event || null,
    requestId: event?.requestId || null,
    durationMs: event?.durationMs ?? null,
    ...(details.mint ? { mint: details.mint } : {}),
    ...(details.developerWallet ? { wallet: details.developerWallet } : {}),
    ...(details.developerTokensWallet ? { developerTokensWallet: details.developerTokensWallet } : {}),
  };
}

function createDevscanMetricsReporter() {
  if (!metricsLogger || typeof metricsLogger.debug !== 'function') return null;
  return (event) => {
    const payload = buildDevscanMetricsPayload(event);
    metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
  };
}

/**
 * Validate and normalize devscan worker payloads.
 *
 * @param {DevscanWorkerPayload} payload
 * @returns {DevscanWorkerPayload}
 */
function validateDevscanPayload(payload) {
  const out = {};
  if (payload && typeof payload.mint === 'string' && payload.mint.trim()) {
    out.mint = payload.mint.trim();
  }
  if (payload && typeof payload.developerWallet === 'string' && payload.developerWallet.trim()) {
    out.developerWallet = payload.developerWallet.trim();
  }
  if (payload && typeof payload.developerTokensWallet === 'string' && payload.developerTokensWallet.trim()) {
    out.developerTokensWallet = payload.developerTokensWallet.trim();
  }
  if (payload && payload.runAnalysis === false) {
    out.runAnalysis = false;
  }
  if (!out.mint && !out.developerWallet && !out.developerTokensWallet) {
    throw new Error('Devscan payload requires at least one of mint, developerWallet, or developerTokensWallet');
  }
  return out;
}

/**
 * Run the devscan worker via the shared CLI module.
 *
 * @param {DevscanWorkerPayload} payload
 * @returns {Promise<DevscanWorkerResult>}
 */
async function runDevscanWorker(payload) {
  const normalized = validateDevscanPayload(payload);
  const runDevscan = loadDevscanRunner();
  return runDevscan(normalized);
}

createWorkerHarness(runDevscanWorker, {
  workerName: 'devscanWorker',
  logger,
  metricsReporter: createDevscanMetricsReporter(),
});

module.exports = { validateDevscanPayload, runDevscanWorker };
