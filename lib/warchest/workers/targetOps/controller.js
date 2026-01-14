'use strict';

const path = require('path');

const BootyBox = require('../../../../db');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { emitToParent } = require('../sellOps/hudPublisher');
const { buildWorkerEnv, forkWorkerWithPayload } = require('../harness');
const { getHubCoordinator } = require('../../hub');
const {
  createNoopLogger,
  normalizeScopedLogger,
  parseIntervalMs,
  parseNumber,
} = require('../opsUtils');

const DEFAULT_TARGET_LIST_INTERVAL_MS = 300_000;
const DEFAULT_TARGET_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_TARGET_SCAN_CONCURRENCY = 5;
const DEFAULT_TARGET_LIST_TIMEOUT_MS = 120_000;
const MAX_TARGET_LIST_TIMEOUT_MS = 600_000;
const DEFAULT_TARGET_LIST_TIMEOUT_RATIO = 0.8;
const DEFAULT_TARGET_SCAN_TIMEOUT_MS = 120_000;

const SCAN_STATUSES = ['strong_buy', 'buy', 'watch', 'watching', 'approved', 'new'];
const TARGET_SCAN_WORKER_PATH = path.join(__dirname, '..', 'targetScanWorker.js');
const hub = getHubCoordinator({ attachSignals: false });

/**
 * Derive the target list timeout when no explicit value is set.
 *
 * @param {number|null|undefined} explicitTimeoutMs
 * @param {number|null|undefined} intervalMs
 * @returns {number}
 */
function deriveTargetListTimeoutMs(explicitTimeoutMs, intervalMs) {
  if (Number.isFinite(explicitTimeoutMs)) return explicitTimeoutMs;
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return DEFAULT_TARGET_LIST_TIMEOUT_MS;
  const scaled = Math.round(interval * DEFAULT_TARGET_LIST_TIMEOUT_RATIO);
  return Math.min(
    MAX_TARGET_LIST_TIMEOUT_MS,
    Math.max(DEFAULT_TARGET_LIST_TIMEOUT_MS, scaled)
  );
}

function isHudEnv(env) {
  if (!env) return false;
  return env.SC_HUD_MODE === '1' || env.WARCHEST_HUD === '1';
}

function isInkEnv(env) {
  if (!env) return false;
  return env.SC_INK_MODE === '1';
}

function shouldCaptureOutput(env) {
  return isHudEnv(env) || isInkEnv(env);
}

function buildTargetListEnv(env) {
  const sourceEnv = env || process.env;
  return buildWorkerEnv({
    dataEndpoint:
      sourceEnv.WARCHEST_DATA_ENDPOINT
      || sourceEnv.SOLANATRACKER_DATA_ENDPOINT
      || sourceEnv.SOLANATRACKER_URL,
    hudMode: isHudEnv(sourceEnv),
    inkMode: isInkEnv(sourceEnv),
    extraEnv: sourceEnv,
  });
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
  const baseLogger = log || tools.logger || createNoopLogger();
  const logger = normalizeScopedLogger(baseLogger, 'targetOps');
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
  const explicitTargetListTimeoutMs = parseNumber(
    payload.targetListTimeoutMs ?? env.WARCHEST_TARGET_LIST_TIMEOUT_MS,
    null
  );
  const targetListTimeoutMs = deriveTargetListTimeoutMs(
    explicitTargetListTimeoutMs,
    targetListIntervalMs
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
      const workerEnv = buildTargetListEnv(env);
      const captureOutput = shouldCaptureOutput(workerEnv);
      activeTargetList = hub.runTargetList(
        { runOnce: true, skipTargetScan: true },
        {
          timeoutMs: targetListTimeoutMs,
          env: workerEnv,
          captureOutput,
        }
      );
      const response = await activeTargetList;
      const result = response && response.result ? response.result : response;
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
