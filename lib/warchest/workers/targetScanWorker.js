'use strict';

const fs = require('fs');
const path = require('path');

const baseLogger = require('../../logger');
const { createWorkerHarness, safeSerializePayload } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');

const logger = createWorkerLogger({
  workerName: 'targetScanWorker',
  scope: 'targetScanWorker',
  baseLogger,
  includeCallsite: true,
});
const metricsLogger = typeof baseLogger.metrics === 'function'
  ? baseLogger.metrics()
  : baseLogger;

/**
 * @typedef {Object} TargetScanWorkerPayload
 * @property {string|string[]} [mint] - Mint address(es) to scan.
 * @property {string|string[]} [mints] - Mint list (comma-delimited or array).
 * @property {number} [concurrency] - Parallelism for per-mint scans.
 * @property {boolean} [runAnalysis=true] - Whether to run AI scoring.
 * @property {boolean} [sendVectorStore=false] - Upload final artifacts to the vector store.
 * @property {boolean} [skipVectorStore=false] - Skip vector store upload of final artifacts (deprecated).
 * @property {boolean} [forceTokenRefresh=true] - Force API refresh for token info per scan.
 * @property {boolean} [manual=false] - Mark a manual scan run for HUD logging detail.
 */

/**
 * @typedef {import('../../targetScan').runTargetScan} TargetScanRunner
 */

function loadTargetScanRunner() {
  if (process.env.TARGETSCAN_WORKER_RUNNER) {
    const modPath = path.isAbsolute(process.env.TARGETSCAN_WORKER_RUNNER)
      ? process.env.TARGETSCAN_WORKER_RUNNER
      : path.join(process.cwd(), process.env.TARGETSCAN_WORKER_RUNNER);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(modPath);
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.runTargetScan === 'function') return mod.runTargetScan;
    throw new Error('TARGETSCAN_WORKER_RUNNER must export a function or runTargetScan');
  }

  // eslint-disable-next-line global-require
  const { runTargetScan } = require('../../targetScan');
  return runTargetScan;
}

function buildTargetScanMetricsPayload(event) {
  const details = event?.result || event?.payload || {};
  return {
    worker: event?.worker || 'targetScanWorker',
    event: event?.event || null,
    requestId: event?.requestId || null,
    durationMs: event?.durationMs ?? null,
    ...(details.mints ? { mints: details.mints } : {}),
  };
}

function createTargetScanMetricsReporter() {
  if (!metricsLogger || typeof metricsLogger.debug !== 'function') return null;
  return (event) => {
    const payload = buildTargetScanMetricsPayload(event);
    metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
  };
}

/**
 * Validate and normalize target scan worker payloads.
 *
 * @param {TargetScanWorkerPayload} payload
 * @returns {TargetScanWorkerPayload}
 */
function validateTargetScanPayload(payload) {
  const out = {};
  const parseBoolean = (val) => {
    if (val == null) return undefined;
    if (typeof val === 'string') {
      const trimmed = val.trim().toLowerCase();
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
    }
    return Boolean(val);
  };
  if (payload?.mint != null) out.mint = payload.mint;
  if (payload?.mints != null) out.mints = payload.mints;
  if (payload?.concurrency != null) out.concurrency = Number(payload.concurrency);
  const runAnalysis = parseBoolean(payload?.runAnalysis);
  if (runAnalysis !== undefined) out.runAnalysis = runAnalysis;
  const sendVectorStore = parseBoolean(payload?.sendVectorStore);
  if (sendVectorStore !== undefined) out.sendVectorStore = sendVectorStore;
  const skipVectorStore = parseBoolean(payload?.skipVectorStore);
  if (skipVectorStore !== undefined) out.skipVectorStore = skipVectorStore;
  const forceTokenRefresh = parseBoolean(payload?.forceTokenRefresh);
  out.forceTokenRefresh = forceTokenRefresh !== undefined ? forceTokenRefresh : true;
  const manual = parseBoolean(payload?.manual);
  if (manual !== undefined) out.manual = manual;
  return out;
}

async function runTargetScanWorker(payload) {
  const normalized = validateTargetScanPayload(payload);
  const runTargetScan = loadTargetScanRunner();
  return runTargetScan(normalized);
}

/**
 * Parse standalone CLI args (detached mode).
 *
 * @param {string[]} argv
 * @returns {{ payloadFile: string|null }}
 */
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
 * Run in detached mode without IPC (used by spawnWorkerDetached).
 *
 * @param {TargetScanWorkerPayload} payload
 * @returns {Promise<void>}
 */
async function runStandalone(payload) {
  await runTargetScanWorker(payload);
}

if (require.main === module) {
  const { payloadFile } = parseStandaloneArgs(process.argv);
  if (payloadFile) {
    const payloadPath = path.isAbsolute(payloadFile)
      ? payloadFile
      : path.join(process.cwd(), payloadFile);
    if (!fs.existsSync(payloadPath)) {
      logger.error(`[targetScanWorker] payload file not found: ${payloadPath}`);
      process.exit(1);
    }
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    runStandalone(payload).catch((err) => {
      logger.error(`[targetScanWorker] detached run failed: ${err?.message || err}`);
      process.exit(1);
    });
  } else {
    createWorkerHarness(runTargetScanWorker, {
      workerName: 'targetScanWorker',
      logger,
      metricsReporter: createTargetScanMetricsReporter(),
    });
  }
} else {
  createWorkerHarness(runTargetScanWorker, {
    workerName: 'targetScanWorker',
    logger,
    metricsReporter: createTargetScanMetricsReporter(),
  });
}

module.exports = { validateTargetScanPayload, runTargetScanWorker };
