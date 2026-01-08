'use strict';

const path = require('path');

const baseLogger = require('../../logger');
const { createWorkerHarness, safeSerializePayload } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');

const logger = createWorkerLogger({
  workerName: 'dossierWorker',
  scope: 'dossierWorker',
  baseLogger,
  includeCallsite: true,
});
const metricsLogger = typeof baseLogger.metrics === 'function'
  ? baseLogger.metrics()
  : baseLogger;

/**
 * @typedef {Object} DossierWorkerPayload
 * @property {string} wallet - Wallet address to harvest.
 * @property {string} [traderName] - Optional label used for artifacts and AI context.
 * @property {number} [startTime] - Epoch (ms) lower bound for wallet trades.
 * @property {number} [endTime] - Epoch (ms) upper bound for wallet trades.
 * @property {number} [limit] - Max wallet trades to fetch (defaults applied upstream).
 * @property {number} [concurrency] - Parallelism for per-mint trade fetches.
 * @property {boolean} [includeOutcomes] - Include outcome metrics when building features.
 * @property {number} [featureMintCount] - Number of recent mints to expand for AI context.
 * @property {boolean} [runAnalysis=true] - Whether to call the AI job after harvesting.
 */

/**
 * @typedef {import('../../cli/dossier').HarvestResult} DossierWorkerResult
 */

function loadDossierRunner() {
  if (process.env.DOSSIER_WORKER_RUNNER) {
    const modPath = path.isAbsolute(process.env.DOSSIER_WORKER_RUNNER)
      ? process.env.DOSSIER_WORKER_RUNNER
      : path.join(process.cwd(), process.env.DOSSIER_WORKER_RUNNER);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(modPath);
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.harvestWallet === 'function') return mod.harvestWallet;
    throw new Error('DOSSIER_WORKER_RUNNER must export a function or harvestWallet');
  }

  // eslint-disable-next-line global-require
  const { harvestWallet } = require('../../cli/dossier');
  return harvestWallet;
}

function buildDossierMetricsPayload(event) {
  const details = event?.result || event?.payload || {};

  return {
    worker: event?.worker || 'dossierWorker',
    event: event?.event || null,
    requestId: event?.requestId || null,
    durationMs: event?.durationMs ?? null,
    ...(details.wallet ? { wallet: details.wallet } : {}),
    ...(details.traderName ? { traderName: details.traderName } : {}),
  };
}

function createDossierMetricsReporter() {
  if (!metricsLogger || typeof metricsLogger.debug !== 'function') return null;
  return (event) => {
    const payload = buildDossierMetricsPayload(event);
    metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
  };
}

/**
 * Validate and normalize dossier worker payloads.
 *
 * @param {DossierWorkerPayload} payload
 * @returns {DossierWorkerPayload}
 */
function validateDossierPayload(payload) {
  function parseBoolean(val) {
    if (val == null) return undefined;
    if (typeof val === 'string') {
      const trimmed = val.trim().toLowerCase();
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
    }
    return Boolean(val);
  }

  const wallet = payload && typeof payload.wallet === 'string' ? payload.wallet.trim() : '';
  if (!wallet) {
    throw new Error('Dossier payload must include wallet');
  }

  const out = { wallet };
  if (payload.traderName) out.traderName = String(payload.traderName).trim();
  if (payload.startTime != null) out.startTime = Number(payload.startTime);
  if (payload.endTime != null) out.endTime = Number(payload.endTime);
  if (payload.limit != null) out.limit = Number(payload.limit);
  if (payload.concurrency != null) out.concurrency = Number(payload.concurrency);
  const includeOutcomes = parseBoolean(payload.includeOutcomes);
  if (includeOutcomes !== undefined) out.includeOutcomes = includeOutcomes;
  if (payload.featureMintCount != null) out.featureMintCount = Number(payload.featureMintCount);
  const runAnalysis = parseBoolean(payload.runAnalysis);
  if (runAnalysis !== undefined) out.runAnalysis = runAnalysis;

  return out;
}

async function runDossierWorker(payload) {
  const normalized = validateDossierPayload(payload);
  const harvestWallet = loadDossierRunner();
  return harvestWallet(normalized);
}

createWorkerHarness(runDossierWorker, {
  workerName: 'dossierWorker',
  logger,
  metricsReporter: createDossierMetricsReporter(),
});

module.exports = { validateDossierPayload, runDossierWorker };
