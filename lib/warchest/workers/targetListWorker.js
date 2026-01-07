'use strict';

const fs = require('fs');
const path = require('path');

const baseLogger = require('../../logger');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
const { createArtifactWriter } = require('../../persist/jsonArtifacts');
const { bounceTokens } = require('../../analysis/tokenBouncer');
const { createWorkerHarness } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');

const WORKER_NAME = 'targetListWorker';
const ARTIFACT_COMMAND = 'target-list';
const DEFAULT_INTERVAL_MS = 300_000;
const INTERVAL_ENV = 'WARCHEST_TARGET_LIST_INTERVAL_MS';

const logger = createWorkerLogger({
  workerName: WORKER_NAME,
  scope: 'targetList',
  baseLogger,
  includeCallsite: true,
});

/**
 * @typedef {Object} TargetListWorkerPayload
 * @property {boolean} [runOnce=true] - Run a single fetch cycle and exit.
 * @property {number|string|null} [intervalMs] - Override interval in ms, or "OFF" to disable.
 */

/**
 * Normalize boolean payloads.
 *
 * @param {any} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBooleanFlag(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return Boolean(value);
}

/**
 * Parse interval values and support OFF/disabled.
 *
 * @param {any} value
 * @param {number|null} fallback
 * @returns {number|null}
 */
function parseIntervalMs(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['off', 'disabled', 'false', '0', 'no'].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return null;
  return parsed;
}

/**
 * Validate and normalize target list payloads.
 *
 * @param {TargetListWorkerPayload} payload
 * @returns {{ runOnce: boolean, intervalMs: number|null }}
 */
function validateTargetListPayload(payload) {
  const hasIntervalOverride =
    payload && Object.prototype.hasOwnProperty.call(payload, 'intervalMs');
  const envInterval = parseIntervalMs(process.env[INTERVAL_ENV], DEFAULT_INTERVAL_MS);
  const intervalMs = hasIntervalOverride
    ? parseIntervalMs(payload.intervalMs, envInterval)
    : envInterval;
  const runOnce = parseBooleanFlag(payload?.runOnce, true);

  return { runOnce, intervalMs };
}

function countTokens(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.tokens)) return payload.tokens.length;
  return null;
}

/**
 * Fetch target list data and write raw artifacts.
 *
 * @param {{ dataClient: ReturnType<typeof createSolanaTrackerDataClient> }} deps
 * @returns {Promise<{ runId: string, volume: any, trending: any, artifacts: { volumePath: string|null, trendingPath: string|null } }>}
 */
async function fetchTargetList({ dataClient }) {
  const artifacts = createArtifactWriter({ command: ARTIFACT_COMMAND, logger });
  const [volumeRaw, trendingRaw] = await Promise.all([
    dataClient.getTokensByVolumeWithTimeframe({ timeframe: '30m' }),
    dataClient.getTrendingTokens({ timeframe: '1h' }),
  ]);

  const volume = applyTokenBouncer(volumeRaw);
  const trending = applyTokenBouncer(trendingRaw);

  const volumePath = artifacts.write('raw', 'tokens-by-volume-30m', volume);
  const trendingPath = artifacts.write('raw', 'trending-tokens-1h', trending);

  return {
    runId: artifacts.runId,
    volume,
    trending,
    artifacts: { volumePath, trendingPath },
  };
}

/**
 * Apply token bouncer to different response shapes.
 *
 * @param {any} payload
 * @returns {any}
 */
function applyTokenBouncer(payload) {
  if (Array.isArray(payload)) {
    return bounceTokens(payload, { logger });
  }
  if (payload && Array.isArray(payload.tokens)) {
    return { ...payload, tokens: bounceTokens(payload.tokens, { logger }) };
  }
  return payload;
}

/**
 * Run a single target list fetch cycle.
 *
 * @param {{ dataClient: ReturnType<typeof createSolanaTrackerDataClient> }} deps
 * @returns {Promise<object>}
 */
async function runTargetListOnce({ dataClient }) {
  const startedAt = Date.now();
  const { runId, volume, trending, artifacts } = await fetchTargetList({ dataClient });
  const endedAt = Date.now();

  return {
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    artifacts,
    counts: {
      volume: countTokens(volume),
      trending: countTokens(trending),
    },
  };
}

/**
 * Run the target list worker in IPC mode.
 *
 * @param {TargetListWorkerPayload} payload
 * @returns {Promise<object>}
 */
async function runTargetListWorker(payload) {
  const { runOnce, intervalMs } = validateTargetListPayload(payload || {});

  if (!runOnce) {
    throw new Error('targetListWorker IPC mode only supports runOnce=true; use detached mode for timers.');
  }

  const dataClient = createSolanaTrackerDataClient();
  try {
    return await runTargetListOnce({ dataClient });
  } finally {
    await dataClient.close();
  }
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
 * @param {TargetListWorkerPayload} payload
 * @returns {Promise<void>}
 */
async function runStandalone(payload) {
  const { runOnce, intervalMs } = validateTargetListPayload(payload || {});
  const dataClient = createSolanaTrackerDataClient();
  let timer = null;

  const shutdown = async () => {
    if (timer) clearInterval(timer);
    await dataClient.close();
  };

  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));

  if (runOnce || !intervalMs) {
    if (!intervalMs && !runOnce) {
      logger.info(`[targetList] ${INTERVAL_ENV} disabled; exiting.`);
      await shutdown();
      return;
    }
    await runTargetListOnce({ dataClient });
    await shutdown();
    return;
  }

  logger.info(`[targetList] detached timer every ${intervalMs}ms`);
  try {
    await runTargetListOnce({ dataClient });
  } catch (err) {
    logger.warn(`[targetList] initial fetch failed: ${err?.message || err}`);
  }
  timer = setInterval(async () => {
    try {
      await runTargetListOnce({ dataClient });
    } catch (err) {
      logger.warn(`[targetList] interval fetch failed: ${err?.message || err}`);
    }
  }, intervalMs);
}

if (require.main === module) {
  const { payloadFile } = parseStandaloneArgs(process.argv);
  if (payloadFile) {
    const payloadPath = path.isAbsolute(payloadFile)
      ? payloadFile
      : path.join(process.cwd(), payloadFile);
    if (!fs.existsSync(payloadPath)) {
      logger.error(`[targetList] payload file not found: ${payloadPath}`);
      process.exit(1);
    }
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    runStandalone(payload).catch((err) => {
      logger.error(`[targetList] detached run failed: ${err?.message || err}`);
      process.exit(1);
    });
  } else {
    createWorkerHarness(runTargetListWorker, {
      workerName: WORKER_NAME,
      logger,
    });
  }
} else {
  createWorkerHarness(runTargetListWorker, {
    workerName: WORKER_NAME,
    logger,
  });
}

module.exports = {
  parseIntervalMs,
  validateTargetListPayload,
  runTargetListOnce,
  runTargetListWorker,
  runStandalone,
};
