'use strict';

const path = require('path');

const BootyBox = require('../../../../db');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { loadStrategyDocs } = require('../sellOps/strategyDocs');
const { emitToParent } = require('../sellOps/hudPublisher');
const { toPositionSummary } = require('../sellOps/positionAdapter');
const { forkWorkerWithPayload } = require('../harness');
const { persistBuyOpsEvaluation } = require('./persistence');

const DEFAULT_EVAL_INTERVAL_MS = 60_000;
const DEFAULT_EVAL_CONCURRENCY = 6;
const DEFAULT_MIN_BUY_SCORE = 65;
const DEFAULT_EVAL_TIMEOUT_MS = 20_000;

const EVAL_STATUSES = ['strong_buy', 'buy', 'watch'];
const EVAL_WORKER_PATH = path.join(__dirname, 'evalWorker.js');

const STRATEGY_DOCS = loadStrategyDocs();
const STRATEGY_LIST = [STRATEGY_DOCS.flash, STRATEGY_DOCS.hybrid, STRATEGY_DOCS.campaign].filter(Boolean);
const STRATEGY_LOOKUP = (() => {
  const map = new Map();
  const addKey = (key, doc) => {
    if (!key) return;
    const normalized = String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) return;
    map.set(normalized, doc);
  };

  for (const doc of STRATEGY_LIST) {
    addKey(doc.name, doc);
    addKey(doc.strategyId, doc);
  }

  // Common short names
  addKey('flash', STRATEGY_DOCS.flash);
  addKey('hybrid', STRATEGY_DOCS.hybrid);
  addKey('campaign', STRATEGY_DOCS.campaign);

  return map;
})();

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

function normalizeMint(mint) {
  return mint ? String(mint).trim().toLowerCase() : '';
}

function resolveStrategyOverride(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return STRATEGY_LOOKUP.get(key) || null;
}

function resolveStrategyLabel(rawValue, doc) {
  if (doc && doc.name) return doc.name;
  if (rawValue) return String(rawValue).trim();
  return 'inferred';
}

/**
 * @typedef {Object} BuyOpsController
 * @property {Function} start
 * @property {Function} stop
 */

/**
 * Create a BuyOps controller that schedules the evaluation loop.
 *
 * @param {Object} payload
 * @param {Object} tools
 * @param {Object} log
 * @returns {BuyOpsController}
 */
function createBuyOpsController(payload = {}, tools = {}, log) {
  const logger = log || console;
  const env = tools.env || process.env;

  const evaluationIntervalMs = parseIntervalMs(
    payload.evaluationIntervalMs ??
      payload.evalIntervalMs ??
      payload.targetScanIntervalMs ??
      env.WARCHEST_BUYOPS_EVAL_INTERVAL_MS,
    DEFAULT_EVAL_INTERVAL_MS
  );
  const evaluationConcurrency = Math.max(
    1,
    parseNumber(
      payload.evaluationConcurrency ?? payload.evalConcurrency ?? env.WARCHEST_BUYOPS_EVAL_CONCURRENCY,
      DEFAULT_EVAL_CONCURRENCY
    )
  );
  const minScore = parseNumber(payload.minScore, DEFAULT_MIN_BUY_SCORE);
  const evalTimeoutMs = parseNumber(
    payload.evalTimeoutMs ?? env.WARCHEST_BUYOPS_EVAL_TIMEOUT_MS,
    DEFAULT_EVAL_TIMEOUT_MS
  );

  let evaluationTimer = null;
  let heartbeatTimer = null;
  let runningEvaluation = false;
  let runningEvaluationStartedAt = null;
  let stopped = false;
  let lastEvaluationStartedAt = null;
  let lastEvaluationCompletedAt = null;
  let stopFn = null;

  async function ensureBootyBox() {
    try {
      await ensureBootyBoxInit();
      return true;
    } catch (err) {
      logger.warn(`[buyOps] BootyBox init failed: ${err?.message || err}`);
      return false;
    }
  }

  function loadDefaultFundingWallet() {
    if (typeof BootyBox.getDefaultFundingWallet !== 'function') return null;
    return BootyBox.getDefaultFundingWallet();
  }

  function buildTargetStrategyUpdate(target, strategyDoc) {
    if (!target || !strategyDoc) return null;
    const now = Date.now();
    return {
      mint: target.mint,
      symbol: target.symbol || null,
      name: target.name || null,
      status: target.status || 'new',
      strategy: strategyDoc.name || null,
      strategyId: strategyDoc.strategyId || null,
      source: target.source || 'buyOps',
      tags: target.tags || null,
      notes: target.notes || null,
      vectorStoreId: target.vector_store_id || null,
      vectorStoreFileId: target.vector_store_file_id || null,
      vectorStoreUpdatedAt: Number.isFinite(target.vector_store_updated_at)
        ? target.vector_store_updated_at
        : null,
      confidence: Number.isFinite(target.confidence) ? target.confidence : null,
      score: Number.isFinite(target.score) ? target.score : null,
      mintVerified: target.mint_verified === 1,
      createdAt: Number.isFinite(target.created_at) ? target.created_at : now,
      updatedAt: now,
      lastCheckedAt: now,
    };
  }

  async function runEvaluationTick() {
    if (runningEvaluation || stopped) {
      if (runningEvaluation && runningEvaluationStartedAt) {
        const ageMs = Date.now() - runningEvaluationStartedAt;
        if (Number.isFinite(ageMs) && ageMs > evalTimeoutMs) {
          logger.warn(`[buyOps] evaluation still running after ${Math.round(ageMs / 1000)}s; skipping new tick.`);
        }
      }
      return null;
    }
    runningEvaluation = true;
    runningEvaluationStartedAt = Date.now();
    lastEvaluationStartedAt = runningEvaluationStartedAt;
    try {
      const decisions = { buy: 0, watch: 0, skip: 0 };
      let evaluated = 0;
      let errors = 0;
      const hasBootyBox = await ensureBootyBox();
      const wallet = loadDefaultFundingWallet();
      if (!hasBootyBox) {
        emitToParent('buyOps:heartbeat', {
          ts: Date.now(),
          walletAlias: null,
          status: 'skipped',
          note: 'bootybox unavailable',
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      if (!wallet) {
        logger.warn('[buyOps] default funding wallet missing; skipping evaluation.');
        emitToParent('buyOps:heartbeat', {
          ts: Date.now(),
          walletAlias: null,
          status: 'skipped',
          note: 'default funding wallet missing',
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      const walletStrategyRaw = wallet.strategy || wallet.strategyId || wallet.strategy_id || null;
      const walletStrategyDoc = resolveStrategyOverride(walletStrategyRaw);
      const strategyLabel = resolveStrategyLabel(walletStrategyRaw, walletStrategyDoc);
      if (walletStrategyRaw && !walletStrategyDoc) {
        logger.warn(
          `[buyOps] wallet strategy "${walletStrategyRaw}" did not match known strategies; falling back to inference.`
        );
      }

      if (typeof BootyBox.listTargetsByPriority !== 'function') {
        logger.warn('[buyOps] listTargetsByPriority unavailable; skipping evaluation.');
        emitToParent('buyOps:heartbeat', {
          ts: Date.now(),
          walletAlias: wallet.alias,
          status: 'skipped',
          strategyLabel,
          note: 'listTargetsByPriority unavailable',
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      const targets = BootyBox.listTargetsByPriority({ statuses: EVAL_STATUSES, minScore });
      if (!targets.length) {
        emitToParent('buyOps:heartbeat', {
          ts: Date.now(),
          walletAlias: wallet.alias,
          status: 'idle',
          strategyLabel,
          targets: 0,
          evaluated,
          decisions,
          errors,
          note: 'no targets to evaluate',
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      const openPositions = typeof BootyBox.loadOpenPositions === 'function'
        ? BootyBox.loadOpenPositions(wallet.alias)
        : { rows: [] };
      const openRows = Array.isArray(openPositions?.rows) ? openPositions.rows : [];
      const openByMint = new Map(openRows.map((row) => [normalizeMint(row.coin_mint), row]));

      const entries = [];
      for (const target of targets) {
        const mint = target?.mint;
        if (!mint) continue;
        const openRow = openByMint.get(normalizeMint(mint)) || null;
        const targetStrategyDoc = resolveStrategyOverride(target?.strategy || target?.strategy_id);
        const position = openRow
          ? toPositionSummary(openRow)
          : {
              walletId: wallet.walletId,
              walletAlias: wallet.alias,
              mint,
              tradeUuid: null,
              strategyId: targetStrategyDoc?.strategyId || null,
              strategyName: targetStrategyDoc?.name || null,
              currentTokenAmount: null,
              source: 'buyOps',
            };

        if (openRow && !position.strategyName && targetStrategyDoc) {
          position.strategyName = targetStrategyDoc.name || null;
          position.strategyId = targetStrategyDoc.strategyId || null;
        }

        entries.push({ target, position, targetStrategyDoc });
      }

      const workerTimeoutMs = Number.isFinite(evalTimeoutMs)
        ? Math.max(10_000, evalTimeoutMs + 5_000)
        : 30_000;
      let cursor = 0;

      const runNext = async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= entries.length) return;
          const entry = entries[idx];
          const mint = entry?.position?.mint || entry?.target?.mint || 'mint';
          const evalStartedAt = Date.now();
          logger.info(`[buyOps] evaluating mint=${mint}`);

          try {
            const { result } = await forkWorkerWithPayload(EVAL_WORKER_PATH, {
              payload: {
                position: entry.position,
                target: entry.target,
                walletStrategyRaw,
                minScore,
                eventIntervals: payload.eventIntervals || ['5m', '15m', '1h'],
                ohlcv: {
                  type: payload.ohlcvType || '1m',
                  lookbackMs: payload.ohlcvLookbackMs || 60 * 60 * 1000,
                  fastCache: true,
                  removeOutliers: true,
                },
                indicators: {
                  vwapPeriods: payload.vwapPeriods ?? 60,
                },
                includeCandles: Boolean(payload.includeCandles),
                evalTimeoutMs,
              },
              env,
              timeoutMs: workerTimeoutMs,
            });

            const evalResult = result || null;
            evaluated += 1;
            if (evalResult?.decision && Object.prototype.hasOwnProperty.call(decisions, evalResult.decision)) {
              decisions[evalResult.decision] += 1;
            } else {
              decisions.skip += 1;
            }
            const reasonList = Array.isArray(evalResult?.reasons) ? evalResult.reasons : [];
            const reasonText = ` reasons=${JSON.stringify(reasonList)}`;
            logger.info(
              `[buyOps] evaluated mint=${mint} decision=${evalResult?.decision || 'n/a'} ` +
                `ms=${Date.now() - evalStartedAt}${reasonText}`
            );

            if (!walletStrategyDoc && !entry.targetStrategyDoc && evalResult?.chosenStrategy?.name) {
              const update = buildTargetStrategyUpdate(entry.target, evalResult.chosenStrategy);
              if (update && typeof BootyBox.addUpdateTarget === 'function') {
                try {
                  BootyBox.addUpdateTarget(update);
                } catch (err) {
                  logger.warn(`[buyOps] failed to persist target strategy for ${mint}: ${err?.message || err}`);
                }
              }
            }

            if (
              evalResult?.decision === 'buy' &&
              evalResult?.evaluation?.strategy?.name &&
              entry.position?.positionId &&
              typeof BootyBox.updatePositionStrategyName === 'function'
            ) {
              try {
                BootyBox.updatePositionStrategyName({
                  positionId: entry.position.positionId,
                  strategyName: evalResult.evaluation.strategy.name,
                });
              } catch (err) {
                logger.warn(`[buyOps] failed to update position strategy for ${mint}: ${err?.message || err}`);
              }
            }

            if (evalResult?.evaluation) {
              const snapshot = {
                ts: Date.now(),
                walletId: wallet.walletId,
                walletAlias: wallet.alias,
                tradeUuid: entry.position.tradeUuid || null,
                mint,
                decision: evalResult.decision,
                reasons: evalResult.reasons,
                regime: evalResult.regime,
                evaluation: evalResult.evaluation,
              };

              persistBuyOpsEvaluation({
                bootyBox: BootyBox,
                target: entry.target,
                snapshot,
                logger,
              });
            }
          } catch (err) {
            errors += 1;
            logger.warn(
              `[buyOps] evaluation failed mint=${mint} ms=${Date.now() - evalStartedAt}: ${err?.message || err}`
            );
          }

          await new Promise((resolve) => setImmediate(resolve));
        }
      };

      const workerCount = Math.min(evaluationConcurrency, entries.length);
      const workers = Array.from({ length: workerCount }, () => runNext());
      await Promise.all(workers);

      lastEvaluationCompletedAt = Date.now();
      emitToParent('buyOps:heartbeat', {
        ts: Date.now(),
        walletAlias: wallet.alias,
        status: 'evaluated',
        strategyLabel,
        targets: entries.length,
        evaluated,
        decisions,
        errors,
        note: runningEvaluation ? 'evaluation running' : 'evaluation idle',
      });

      return {
        targets: entries.length,
        evaluated,
        decisions,
        errors,
      };
    } finally {
      runningEvaluation = false;
      runningEvaluationStartedAt = null;
    }
  }

  async function stop(reason) {
    if (!stopped) stopped = true;
    if (evaluationTimer) clearInterval(evaluationTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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
      emitToParent('buyOps:heartbeat', {
        ts: Date.now(),
        walletAlias: null,
        status: 'starting',
        evaluationIntervalMs,
        evaluationConcurrency,
        minScore,
      });

      if (evaluationIntervalMs != null) {
        runEvaluationTick()
          .then((evalStats) => {
            if (!evalStats) return;
            logger.info(
              `[buyOps] evaluation summary targets=${evalStats.targets} evaluated=${evalStats.evaluated} ` +
                `buy=${evalStats.decisions.buy} watch=${evalStats.decisions.watch} skip=${evalStats.decisions.skip} ` +
                `errors=${evalStats.errors}`
            );
          })
          .catch((err) => {
            logger.warn(`[buyOps] evaluation tick failed: ${err?.message || err}`);
          });
        evaluationTimer = setInterval(() => {
          runEvaluationTick()
            .then((evalStats) => {
              if (!evalStats) return;
              logger.info(
                `[buyOps] evaluation summary targets=${evalStats.targets} evaluated=${evalStats.evaluated} ` +
                  `buy=${evalStats.decisions.buy} watch=${evalStats.decisions.watch} skip=${evalStats.decisions.skip} ` +
                  `errors=${evalStats.errors}`
              );
            })
            .catch((err) => {
              logger.warn(`[buyOps] evaluation tick failed: ${err?.message || err}`);
            });
        }, evaluationIntervalMs);
      } else {
        logger.info('[buyOps] evaluation interval disabled.');
      }

      heartbeatTimer = setInterval(() => {
        if (stopped) return;
        emitToParent('buyOps:heartbeat', {
          ts: Date.now(),
          walletAlias: null,
          status: 'alive',
          evaluationIntervalMs,
          evaluationConcurrency,
          lastEvaluationStartedAt,
          lastEvaluationCompletedAt,
          note: runningEvaluation ? 'evaluation running' : 'evaluation idle',
        });
        logger.info(
          `[buyOps] heartbeat alive evaluation=${lastEvaluationCompletedAt ? 'ok' : 'pending'}`
        );
      }, 60_000);

      logger.info(
        `[buyOps] started evaluationIntervalMs=${evaluationIntervalMs ?? 'disabled'} ` +
          `evaluationConcurrency=${evaluationConcurrency} minScore=${minScore}`
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
  createBuyOpsController,
};
