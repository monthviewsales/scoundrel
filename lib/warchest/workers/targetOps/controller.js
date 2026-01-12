'use strict';

const path = require('path');

const BootyBox = require('../../../../db');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { emitToParent } = require('../sellOps/hudPublisher');
const { forkWorkerWithPayload } = require('../harness');

const DEFAULT_TARGET_LIST_INTERVAL_MS = 300_000;
const DEFAULT_TARGET_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_TARGET_SCAN_CONCURRENCY = 5;
const DEFAULT_TARGET_LIST_TIMEOUT_MS = 120_000;
const DEFAULT_TARGET_SCAN_TIMEOUT_MS = 120_000;

const SCAN_STATUSES = ['strong_buy', 'buy', 'watch', 'watching', 'approved', 'new'];
const TARGET_LIST_WORKER_PATH = path.join(__dirname, '..', 'targetListWorker.js');
const TARGET_SCAN_WORKER_PATH = path.join(__dirname, '..', 'targetScanWorker.js');

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

  let targetListTimer = null;
  let targetScanTimer = null;
  let heartbeatTimer = null;
  let runningTargetList = false;
  let runningTargetScan = false;
  let stopped = false;
  let activeTargetList = null;
  let activeTargetListStartedAt = null;
  let activeTargetListWarned = false;
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
      activeTargetListStartedAt = Date.now();
      activeTargetListWarned = false;
      activeTargetList = forkWorkerWithPayload(TARGET_LIST_WORKER_PATH, {
        timeoutMs: targetListTimeoutMs,
        env,
        payload: { runOnce: true, skipTargetScan: true },
      });
      const { result } = await activeTargetList;
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
      activeTargetList = null;
      activeTargetListStartedAt = null;
      activeTargetListWarned = false;
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

      logger.info(`[targetOps] targetscan running: mints=${mints.length} concurrency=${scanConcurrency}`);
      activeTargetScanStartedAt = Date.now();
      activeTargetScanWarned = false;
      activeTargetScan = forkWorkerWithPayload(TARGET_SCAN_WORKER_PATH, {
        timeoutMs: targetScanTimeoutMs,
        env,
        payload: {
          mints,
          concurrency: scanConcurrency,
          forceTokenRefresh: true,
        },
      });
      const { result } = await activeTargetScan;
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
      activeTargetScan = null;
      activeTargetScanStartedAt = null;
      activeTargetScanWarned = false;
    }
  }

  async function stop(reason) {
    if (!stopped) stopped = true;
    if (targetListTimer) clearInterval(targetListTimer);
    if (targetScanTimer) clearInterval(targetScanTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (activeTargetList && typeof activeTargetList.stop === 'function') {
      try {
        activeTargetList.stop('shutdown', { graceMs: 5000 });
      } catch (err) {
        logger.warn(`[targetOps] target list stop failed: ${err?.message || err}`);
      }
    }
    if (activeTargetScan && typeof activeTargetScan.stop === 'function') {
      try {
        activeTargetScan.stop('shutdown', { graceMs: 5000 });
      } catch (err) {
        logger.warn(`[targetOps] targetscan stop failed: ${err?.message || err}`);
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
        if (activeTargetList && activeTargetListStartedAt && !activeTargetListWarned) {
          const ageMs = Date.now() - activeTargetListStartedAt;
          if (Number.isFinite(ageMs) && ageMs > targetListTimeoutMs) {
            activeTargetListWarned = true;
            logger.warn(
              `[targetOps] target list still running after ${Math.round(ageMs / 1000)}s`
            );
          }
        }
        if (activeTargetScan && activeTargetScanStartedAt && !activeTargetScanWarned) {
          const ageMs = Date.now() - activeTargetScanStartedAt;
          if (Number.isFinite(ageMs) && ageMs > targetScanTimeoutMs) {
            activeTargetScanWarned = true;
            logger.warn(
              `[targetOps] targetscan still running after ${Math.round(ageMs / 1000)}s`
            );
          }
        }
        emitToParent('targetOps:heartbeat', {
          ts: Date.now(),
          status: 'alive',
          targetListIntervalMs,
          targetScanIntervalMs,
          lastTargetListStartedAt,
          lastTargetListCompletedAt,
          lastTargetScanTickAt,
          lastTargetScanCompletedAt,
          note: `targetList=${activeTargetList ? 'running' : 'idle'} targetScan=${activeTargetScan ? 'running' : 'idle'}`,
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
