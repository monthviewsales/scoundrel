'use strict';

const BootyBox = require('../../../../db');
const { createSolanaTrackerDataClient } = require('../../../solanaTrackerDataClient');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { runTargetScan } = require('../../../targetScan');
const { runTargetListOnce } = require('../targetListWorker');
const { emitToParent } = require('../sellOps/hudPublisher');
const { withTimeout } = require('../warchestServiceHelpers');

const DEFAULT_TARGET_LIST_INTERVAL_MS = 300_000;
const DEFAULT_TARGET_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_TARGET_SCAN_CONCURRENCY = 5;
const DEFAULT_TARGET_LIST_TIMEOUT_MS = 120_000;
const DEFAULT_TARGET_SCAN_TIMEOUT_MS = 120_000;

const SCAN_STATUSES = ['strong_buy', 'buy', 'watch', 'watching', 'approved', 'new'];

function parseIntervalMs(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['off', 'disabled', 'false', '0', 'no'].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

/**
 * @typedef {Object} TargetOpsController
 * @property {Function} start
 * @property {Function} stop
 */

/**
 * Create a TargetOps controller that schedules target-list + targetscan loops.
 *
 * @param {Object} payload
 * @param {Object} tools
 * @param {Object} log
 * @returns {TargetOpsController}
 */
function createTargetOpsController(payload = {}, tools = {}, log) {
  const logger = log || console;
  const env = tools.env || process.env;

  const targetListIntervalMs = parseIntervalMs(
    payload.targetListIntervalMs ?? env.WARCHEST_TARGET_LIST_INTERVAL_MS,
    DEFAULT_TARGET_LIST_INTERVAL_MS
  );
  const targetScanIntervalMs = parseIntervalMs(
    payload.targetScanIntervalMs ?? env.WARCHEST_TARGET_SCAN_INTERVAL_MS,
    DEFAULT_TARGET_SCAN_INTERVAL_MS
  );
  const scanConcurrency = Math.max(
    1,
    parseNumber(payload.scanConcurrency ?? env.WARCHEST_TARGET_SCAN_CONCURRENCY, DEFAULT_TARGET_SCAN_CONCURRENCY)
  );
  const targetListTimeoutMs = parseNumber(
    payload.targetListTimeoutMs ?? env.WARCHEST_TARGET_LIST_TIMEOUT_MS,
    DEFAULT_TARGET_LIST_TIMEOUT_MS
  );
  const targetScanTimeoutMs = parseNumber(
    payload.targetScanTimeoutMs ?? env.WARCHEST_TARGET_SCAN_TIMEOUT_MS,
    DEFAULT_TARGET_SCAN_TIMEOUT_MS
  );

  let dataClient = null;
  let targetListTimer = null;
  let targetScanTimer = null;
  let heartbeatTimer = null;
  let runningTargetList = false;
  let runningTargetScan = false;
  let stopped = false;
  let activeTargetScan = null;
  let activeTargetScanStartedAt = null;
  let activeTargetScanWarned = false;
  let lastTargetListStartedAt = null;
  let lastTargetListCompletedAt = null;
  let lastTargetScanTickAt = null;
  let lastTargetScanCompletedAt = null;
  let stopFn = null;

  async function ensureBootyBox() {
    try {
      await ensureBootyBoxInit();
      return true;
    } catch (err) {
      logger.warn(`[targetOps] BootyBox init failed: ${err?.message || err}`);
      return false;
    }
  }

  async function runTargetListTick() {
    if (runningTargetList || stopped) return;
    runningTargetList = true;
    lastTargetListStartedAt = Date.now();
    try {
      logger.info('[targetOps] target list tick starting.');
      const result = await withTimeout(
        runTargetListOnce({ dataClient, skipTargetScan: true }),
        targetListTimeoutMs,
        'targetOps target list'
      );
      const summary = result?.summary || {};
      lastTargetListCompletedAt = Date.now();
      logger.info(
        `[targetOps] target list tick completed: mints=${summary.uniqueMints ?? 'n/a'} ` +
          `targets=${summary.targetsUpserted ?? 'n/a'} pruned=${summary.targetsPruned ?? 'n/a'}`
      );
      emitToParent('targetOps:heartbeat', {
        ts: Date.now(),
        status: 'targetListComplete',
        runId: result?.runId || null,
        counts: result?.counts || null,
      });
    } catch (err) {
      logger.warn(`[targetOps] target list tick failed: ${err?.message || err}`);
      emitToParent('targetOps:heartbeat', {
        ts: Date.now(),
        status: 'error',
        note: `target list failed: ${err?.message || err}`,
      });
    } finally {
      runningTargetList = false;
    }
  }

  async function runTargetScanTick() {
    if (runningTargetScan || stopped) return;
    runningTargetScan = true;
    lastTargetScanTickAt = Date.now();
    try {
      logger.info('[targetOps] target scan tick starting.');
      const hasBootyBox = await ensureBootyBox();
      if (!hasBootyBox || typeof BootyBox.listTargetsForScan !== 'function') {
        logger.warn('[targetOps] listTargetsForScan unavailable; skipping targetscan.');
        return;
      }

      const scanTargets = BootyBox.listTargetsForScan({ statuses: SCAN_STATUSES });
      const mints = scanTargets.map((row) => row && row.mint).filter(Boolean);
      if (!mints.length) {
        logger.info('[targetOps] targetscan skipped: no targets.');
        emitToParent('targetOps:heartbeat', {
          ts: Date.now(),
          status: 'idle',
          note: 'no targets to scan',
        });
        return;
      }

      if (activeTargetScan) {
        const ageMs = activeTargetScanStartedAt ? Date.now() - activeTargetScanStartedAt : null;
        if (!activeTargetScanWarned && Number.isFinite(ageMs) && ageMs > targetScanTimeoutMs) {
          activeTargetScanWarned = true;
          logger.warn(
            `[targetOps] targetscan still running after ${Math.round(ageMs / 1000)}s; skipping new scan.`
          );
        } else {
          logger.info('[targetOps] targetscan already running; skipping new scan.');
        }
        return;
      }

      logger.info(`[targetOps] targetscan running: mints=${mints.length} concurrency=${scanConcurrency}`);
      activeTargetScanStartedAt = Date.now();
      activeTargetScanWarned = false;
      activeTargetScan = runTargetScan({
        mints,
        concurrency: scanConcurrency,
        client: dataClient,
      });
      activeTargetScan
        .then((result) => {
          lastTargetScanCompletedAt = Date.now();
          const results = Array.isArray(result?.results) ? result.results : [];
          const errorCount = results.filter((row) => row && row.error).length;
          logger.info(`[targetOps] targetscan completed: mints=${mints.length} errors=${errorCount}`);
          emitToParent('targetOps:heartbeat', {
            ts: Date.now(),
            status: 'targetScanComplete',
            mints: result?.mints?.length ?? mints.length,
            errors: errorCount,
          });
        })
        .catch((err) => {
          logger.warn(`[targetOps] targetscan failed: ${err?.message || err}`);
          emitToParent('targetOps:heartbeat', {
            ts: Date.now(),
            status: 'error',
            note: `targetscan failed: ${err?.message || err}`,
          });
        })
        .finally(() => {
          activeTargetScan = null;
          activeTargetScanStartedAt = null;
          activeTargetScanWarned = false;
        });
    } catch (err) {
      logger.warn(`[targetOps] targetscan tick failed: ${err?.message || err}`);
      emitToParent('targetOps:heartbeat', {
        ts: Date.now(),
        status: 'error',
        note: `targetscan failed: ${err?.message || err}`,
      });
    } finally {
      logger.info('[targetOps] target scan tick completed.');
      runningTargetScan = false;
    }
  }

  async function stop(reason) {
    if (!stopped) stopped = true;
    if (targetListTimer) clearInterval(targetListTimer);
    if (targetScanTimer) clearInterval(targetScanTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (dataClient && typeof dataClient.close === 'function') {
      try {
        await dataClient.close();
      } catch (err) {
        logger.warn(`[targetOps] data client close failed: ${err?.message || err}`);
      }
    }
    return { status: 'stopped', reason: reason || null };
  }

  const finalPromise = new Promise((resolve, reject) => {
    async function finish(reason) {
      if (stopped) return;
      stopped = true;
      try {
        const result = await stop(reason || 'stopped');
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    async function bootstrap() {
      await ensureBootyBox();
      dataClient = createSolanaTrackerDataClient();
      emitToParent('targetOps:heartbeat', {
        ts: Date.now(),
        status: 'starting',
        targetListIntervalMs,
        targetScanIntervalMs,
      });

      if (targetListIntervalMs != null) {
        runTargetListTick();
        targetListTimer = setInterval(runTargetListTick, targetListIntervalMs);
      } else {
        logger.info('[targetOps] target list interval disabled.');
      }

      if (targetScanIntervalMs != null) {
        runTargetScanTick();
        targetScanTimer = setInterval(runTargetScanTick, targetScanIntervalMs);
      } else {
        logger.info('[targetOps] target scan interval disabled.');
      }

      heartbeatTimer = setInterval(() => {
        if (stopped) return;
        emitToParent('targetOps:heartbeat', {
          ts: Date.now(),
          status: 'alive',
          targetListIntervalMs,
          targetScanIntervalMs,
          lastTargetListStartedAt,
          lastTargetListCompletedAt,
          lastTargetScanTickAt,
          lastTargetScanCompletedAt,
          note: activeTargetScan ? 'targetscan running' : 'targetscan idle',
        });
        logger.info(
          `[targetOps] heartbeat alive targetList=${lastTargetListCompletedAt ? 'ok' : 'pending'} ` +
            `targetScan=${lastTargetScanCompletedAt ? 'ok' : 'pending'}`
        );
      }, 60_000);

      logger.info(
        `[targetOps] started targetListIntervalMs=${targetListIntervalMs ?? 'disabled'} ` +
          `targetScanIntervalMs=${targetScanIntervalMs ?? 'disabled'} scanConcurrency=${scanConcurrency}`
      );
    }

    bootstrap().catch(reject);
    stopFn = finish;
  });

  return {
    start() {
      return finalPromise;
    },
    stop(reason) {
      if (stopFn) stopFn(reason);
      return finalPromise;
    },
  };
}

module.exports = {
  createTargetOpsController,
};
