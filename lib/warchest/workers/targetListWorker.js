"use strict";

const fs = require("fs");
const path = require("path");

const baseLogger = require("../../logger");
const {
  createSolanaTrackerDataClient,
} = require("../../solanaTrackerDataClient");
const { createArtifactWriter } = require("../../persist/jsonArtifacts");
const { bounceTokens } = require("../../analysis/tokenBouncer");
const { ensureTokenInfo } = require("../../services/tokenInfoService");
const {
  pruneTargetsWithVectorStoreCleanup,
} = require("../../services/targetPruning");
const { appendHubEvent } = require("../events");
const {
  createWorkerHarness,
  safeSerializePayload,
  spawnWorkerDetached,
} = require("./harness");
const { createWorkerLogger } = require("./workerLogger");

let BootyBox = {};
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  BootyBox = require("../../../db");
} catch (err) {
  BootyBox = {};
}

const WORKER_NAME = "targetListWorker";
const ARTIFACT_COMMAND = "target-list";
const DEFAULT_INTERVAL_MS = 300_000;
const INTERVAL_ENV = "WARCHEST_TARGET_LIST_INTERVAL_MS";
const TARGETSCAN_CONCURRENCY = 5;

const logger = createWorkerLogger({
  workerName: WORKER_NAME,
  scope: "targetListWorker",
  baseLogger,
  includeCallsite: true,
});
const metricsLogger =
  typeof baseLogger.metrics === "function" ? baseLogger.metrics() : baseLogger;

/**
 * @typedef {Object} TargetListWorkerPayload
 * @property {boolean} [runOnce=true] - Run a single fetch cycle and exit.
 * @property {number|string|null} [intervalMs] - Override interval in ms, or "OFF" to disable.
 * @property {boolean} [skipTargetScan=false] - When true, skip spawning targetscan workers.
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
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
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
  if (["off", "disabled", "false", "0", "no"].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return null;
  return parsed;
}

/**
 * Ensure BootyBox is ready for sc_targets writes.
 *
 * @returns {Promise<boolean>}
 */
async function ensureBootyBoxReady() {
  if (!BootyBox || typeof BootyBox.init !== "function") {
    logger.warn(
      "[targetList] BootyBox client unavailable; skipping target persistence."
    );
    return false;
  }
  try {
    await BootyBox.init();
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(
      `[targetList] BootyBox init failed; skipping target persistence: ${msg}`
    );
    return false;
  }
  if (typeof BootyBox.addUpdateTarget !== "function") {
    logger.warn(
      "[targetList] BootyBox.addUpdateTarget missing; skipping target persistence."
    );
    return false;
  }
  return true;
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
 * Normalize API payload into token entries.
 *
 * @param {any} payload
 * @returns {object[]}
 */
function extractTokenEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload))
    return payload.filter((row) => row && typeof row === "object");
  if (payload && Array.isArray(payload.tokens))
    return payload.tokens.filter((row) => row && typeof row === "object");
  if (payload && payload.token && typeof payload.token === "object")
    return [payload];
  return [];
}

function extractMint(entry) {
  if (!entry || typeof entry !== "object") return null;
  const token =
    entry.token && typeof entry.token === "object" ? entry.token : entry;
  return token.mint || token.address || entry.mint || entry.address || null;
}

function extractTokenLabel(entry) {
  const token =
    entry && entry.token && typeof entry.token === "object"
      ? entry.token
      : entry || {};
  return {
    symbol: token.symbol || entry.symbol || null,
    name: token.name || entry.name || null,
  };
}

function buildTargetListMetricsPayload(event) {
  const details = event?.result || event?.payload || {};

  return {
    worker: event?.worker || WORKER_NAME,
    event: event?.event || null,
    requestId: event?.requestId || null,
    durationMs: event?.durationMs ?? null,
    ...(details.runId ? { runId: details.runId } : {}),
    ...(details.counts ? { counts: details.counts } : {}),
  };
}

function createTargetListMetricsReporter() {
  if (!metricsLogger || typeof metricsLogger.debug !== "function") return null;
  return (event) => {
    const payload = buildTargetListMetricsPayload(event);
    metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
  };
}

/**
 * Validate and normalize target list payloads.
 *
 * @param {TargetListWorkerPayload} payload
 * @returns {{ runOnce: boolean, intervalMs: number|null, skipTargetScan: boolean }}
 */
function validateTargetListPayload(payload) {
  const hasIntervalOverride =
    payload && Object.prototype.hasOwnProperty.call(payload, "intervalMs");
  const envInterval = parseIntervalMs(
    process.env[INTERVAL_ENV],
    DEFAULT_INTERVAL_MS
  );
  const intervalMs = hasIntervalOverride
    ? parseIntervalMs(payload.intervalMs, envInterval)
    : envInterval;
  const runOnce = parseBooleanFlag(payload?.runOnce, true);
  const skipTargetScan = parseBooleanFlag(payload?.skipTargetScan, false);

  return { runOnce, intervalMs, skipTargetScan };
}

function countTokens(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.tokens)) return payload.tokens.length;
  return null;
}

/**
 * Spawn targetScan worker runs for the provided mints.
 *
 * @param {string[]} mints
 * @param {string} runId
 */
function spawnTargetScanWorker(mints, runId) {
  if (!Array.isArray(mints) || !mints.length) return;
  const workerPath = path.join(__dirname, "targetScanWorker.js");
  const prefix = runId
    ? `targetscan-targetlist-${runId}`
    : "targetscan-targetlist";
  try {
    spawnWorkerDetached(workerPath, {
      payload: {
        mints,
        concurrency: TARGETSCAN_CONCURRENCY,
      },
      payloadFilePrefix: prefix,
    });
    logger.info(`[targetList] queued targetscan for ${mints.length} mints`);
  } catch (err) {
    logger.warn(
      `[targetList] failed to spawn targetscan worker: ${err?.message || err}`
    );
  }
}

/**
 * Fetch target list data and write raw artifacts.
 *
 * @param {{ dataClient: ReturnType<typeof createSolanaTrackerDataClient> }} deps
 * @returns {Promise<{ runId: string, volume: any, trending: any, mints: string[], artifacts: { volumePath: string|null, trendingPath: string|null } }>}
 */
async function fetchTargetList({ dataClient }) {
  const artifacts = createArtifactWriter({ command: ARTIFACT_COMMAND, logger });
  const [volumeRaw, trendingRaw] = await Promise.all([
    dataClient.getTokensByVolumeWithTimeframe({ timeframe: "30m" }),
    dataClient.getTrendingTokens({ timeframe: "1h" }),
  ]);

  const volume = applyTokenBouncer(volumeRaw);
  const trending = applyTokenBouncer(trendingRaw);

  const volumeEntries = extractTokenEntries(volume);
  const trendingEntries = extractTokenEntries(trending);
  const tokensByMint = new Map();

  for (const entry of [...volumeEntries, ...trendingEntries]) {
    const mint = extractMint(entry);
    if (!mint) continue;
    if (!tokensByMint.has(mint)) {
      tokensByMint.set(mint, entry);
    }
  }

  const bootyBoxReady = await ensureBootyBoxReady();
  let coinsUpserted = 0;
  let targetsUpserted = 0;
  let targetsFailed = 0;
  let targetsPruned = 0;

  for (const [mint, entry] of tokensByMint.entries()) {
    let info = null;
    try {
      info = await ensureTokenInfo({ mint, client: dataClient });
      if (info) coinsUpserted += 1;
    } catch (err) {
      logger.warn(
        `[targetList] token info fetch failed for ${mint}: ${
          err?.message || err
        }`
      );
    }

    if (bootyBoxReady) {
      try {
        const label = extractTokenLabel(info || entry);
        const existingTarget =
          typeof BootyBox.getTarget === "function"
            ? BootyBox.getTarget(mint)
            : null;
        BootyBox.addUpdateTarget({
          mint,
          symbol: label.symbol,
          name: label.name,
          status: existingTarget?.status || "watch",
          strategy: existingTarget?.strategy || null,
          strategyId:
            existingTarget?.strategy_id || existingTarget?.strategyId || null,
          source: existingTarget?.source || ARTIFACT_COMMAND,
          tags: existingTarget?.tags || null,
          notes: existingTarget?.notes || null,
          vectorStoreId:
            existingTarget?.vector_store_id ||
            existingTarget?.vectorStoreId ||
            null,
          vectorStoreFileId:
            existingTarget?.vector_store_file_id ||
            existingTarget?.vectorStoreFileId ||
            null,
          vectorStoreUpdatedAt: Number.isFinite(
            existingTarget?.vector_store_updated_at
          )
            ? existingTarget.vector_store_updated_at
            : Number.isFinite(existingTarget?.vectorStoreUpdatedAt)
            ? existingTarget.vectorStoreUpdatedAt
            : null,
          confidence: Number.isFinite(existingTarget?.confidence)
            ? existingTarget.confidence
            : null,
          score: Number.isFinite(existingTarget?.score)
            ? existingTarget.score
            : null,
          mintVerified:
            existingTarget?.mint_verified === 1 ||
            existingTarget?.mintVerified === true,
          createdAt: Number.isFinite(existingTarget?.created_at)
            ? existingTarget.created_at
            : Date.now(),
          updatedAt: Date.now(),
          lastCheckedAt: Date.now(),
        });
        targetsUpserted += 1;
      } catch (err) {
        targetsFailed += 1;
        logger.warn(
          `[targetList] failed to upsert target ${mint}: ${err?.message || err}`
        );
      }
    }
  }

  if (bootyBoxReady) {
    try {
      targetsPruned = await pruneTargetsWithVectorStoreCleanup({
        staleMs: 2 * 60 * 60 * 1000,
        archivedTtlMs: 7 * 24 * 60 * 60 * 1000,
        logger,
      });
    } catch (err) {
      logger.warn(
        `[targetList] failed to prune targets: ${err?.message || err}`
      );
    }
  }

  const volumePath = artifacts.write("raw", "tokens-by-volume-30m", volume);
  const trendingPath = artifacts.write("raw", "trending-tokens-1h", trending);

  return {
    runId: artifacts.runId,
    volume,
    trending,
    mints: Array.from(tokensByMint.keys()),
    summary: {
      uniqueMints: tokensByMint.size,
      coinsUpserted,
      targetsUpserted,
      targetsFailed,
      targetsPruned,
    },
    artifacts: { volumePath, trendingPath },
  };
}

/**
 * Run a single target list fetch cycle.
 *
 * @param {{ dataClient: ReturnType<typeof createSolanaTrackerDataClient>, skipTargetScan?: boolean }} deps
 * @returns {Promise<object>}
 */
async function runTargetListOnce({ dataClient, skipTargetScan = false }) {
  const startedAt = Date.now();
  const { runId, volume, trending, artifacts, summary, mints } =
    await fetchTargetList({ dataClient });
  const endedAt = Date.now();
  if (!skipTargetScan) {
    spawnTargetScanWorker(mints, runId);
  }

  try {
    appendHubEvent({
      type: "targetList",
      runId,
      status: "complete",
      observedAt: new Date().toISOString(),
      counts: {
        volume: countTokens(volume),
        trending: countTokens(trending),
      },
      summary: summary || null,
    });
  } catch (err) {
    logger.warn(
      `[targetList] failed to append hub event: ${err?.message || err}`
    );
  }

  return {
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    artifacts,
    summary: summary || null,
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
  const { runOnce, intervalMs, skipTargetScan } = validateTargetListPayload(
    payload || {}
  );

  if (!runOnce) {
    throw new Error(
      "targetListWorker IPC mode only supports runOnce=true; use detached mode for timers."
    );
  }

  const dataClient = createSolanaTrackerDataClient();
  try {
    return await runTargetListOnce({ dataClient, skipTargetScan });
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
    if (args[i] === "--payload-file") {
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
  const { runOnce, intervalMs, skipTargetScan } = validateTargetListPayload(
    payload || {}
  );
  const dataClient = createSolanaTrackerDataClient();
  let timer = null;

  const shutdown = async () => {
    if (timer) clearInterval(timer);
    await dataClient.close();
  };

  process.once("SIGINT", () => shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown().then(() => process.exit(0)));

  if (runOnce || !intervalMs) {
    if (!intervalMs && !runOnce) {
      logger.info(`[targetList] ${INTERVAL_ENV} disabled; exiting.`);
      await shutdown();
      return;
    }
    await runTargetListOnce({ dataClient, skipTargetScan });
    await shutdown();
    return;
  }

  logger.info(`[targetList] detached timer every ${intervalMs}ms`);
  try {
    await runTargetListOnce({ dataClient, skipTargetScan });
  } catch (err) {
    logger.warn(`[targetList] initial fetch failed: ${err?.message || err}`);
  }
  timer = setInterval(async () => {
    try {
      await runTargetListOnce({ dataClient, skipTargetScan });
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
    const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    runStandalone(payload).catch((err) => {
      logger.error(`[targetList] detached run failed: ${err?.message || err}`);
      process.exit(1);
    });
  } else {
    createWorkerHarness(runTargetListWorker, {
      workerName: WORKER_NAME,
      logger,
      metricsReporter: createTargetListMetricsReporter(),
    });
  }
} else {
  createWorkerHarness(runTargetListWorker, {
    workerName: WORKER_NAME,
    logger,
    metricsReporter: createTargetListMetricsReporter(),
  });
}

module.exports = {
  parseIntervalMs,
  validateTargetListPayload,
  runTargetListOnce,
  runTargetListWorker,
  runStandalone,
};
