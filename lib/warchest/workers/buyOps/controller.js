'use strict';

const BootyBox = require('../../../../db');
const { createSolanaTrackerDataClient } = require('../../../solanaTrackerDataClient');
const { computeMarketRegime } = require('../../../analysis/indicators');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { runTargetScan } = require('../../../targetScan');
const { buildEvaluation } = require('../../../../db/src/services/evaluationService');
const { loadStrategyDocs } = require('../sellOps/strategyDocs');
const { chooseStrategy, evalQualify, recommendAction } = require('../sellOps/decisionEngine');
const { toPositionSummary } = require('../sellOps/positionAdapter');
const { runTargetListOnce } = require('../targetListWorker');
const { persistBuyOpsEvaluation } = require('./persistence');

const DEFAULT_TARGET_LIST_INTERVAL_MS = 300_000;
const DEFAULT_TARGET_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_TARGET_SCAN_CONCURRENCY = 5;
const DEFAULT_MIN_BUY_SCORE = 65;

const SCAN_STATUSES = ['strong_buy', 'buy', 'watch', 'watching', 'approved', 'new'];
const EVAL_STATUSES = ['strong_buy', 'buy', 'watch'];

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

function normalizeMint(mint) {
  return mint ? String(mint).trim().toLowerCase() : '';
}

function resolveStrategyOverride(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return STRATEGY_LOOKUP.get(key) || null;
}

function shouldSkipExitabilityGate(position, evaluation) {
  const hasTokens = Number.isFinite(Number(position?.currentTokenAmount)) && Number(position.currentTokenAmount) > 0;
  const hasExitability = Number.isFinite(Number(evaluation?.derived?.liquidityToPositionRatio));
  return !hasTokens && !hasExitability;
}

function evalQualifyForBuy(strategy, evaluation, skipExitabilityGate) {
  if (!skipExitabilityGate) return evalQualify(strategy, evaluation);
  const gates = Array.isArray(strategy?.qualify?.gates) ? strategy.qualify.gates : [];
  const filtered = gates.filter((gate) => gate && gate.id !== 'gate.liquidity.exitability');
  if (filtered.length === gates.length) return evalQualify(strategy, evaluation);
  const patched = {
    ...strategy,
    qualify: {
      ...(strategy?.qualify || {}),
      gates: filtered,
    },
  };
  return evalQualify(patched, evaluation);
}

function buildDecisionReasons(target, qualify, skipExitabilityGate, minScore) {
  const reasons = [];
  const status = target?.status ? String(target.status).toLowerCase() : 'unknown';
  const score = Number(target?.score);
  const confidence = Number(target?.confidence);

  reasons.push(`status:${status}`);
  if (Number.isFinite(score)) reasons.push(`score:${score}`);
  if (Number.isFinite(confidence)) reasons.push(`confidence:${confidence}`);
  if (Number.isFinite(minScore)) reasons.push(`minScore:${minScore}`);
  if (skipExitabilityGate) reasons.push('gateOverride:liquidity_exitability');

  if (qualify?.failed?.length) {
    reasons.push(`qualifyFailed:${qualify.failed.length}`);
    qualify.failed.slice(0, 3).forEach((gate) => {
      reasons.push(`gateFail:${gate.id}:${gate.severityOnFail}`);
    });
  } else {
    reasons.push('qualify:pass');
  }

  return reasons;
}

function resolveBuyDecision(target, qualify, minScore) {
  const status = target?.status ? String(target.status).toLowerCase() : '';
  const score = Number(target?.score);
  const meetsScore = Number.isFinite(score) && Number.isFinite(minScore)
    ? score >= minScore
    : false;

  const isBuyStatus = status === 'buy' || status === 'strong_buy';
  const isWatchStatus = status === 'watch' || status === 'watching';

  if (isBuyStatus && meetsScore) {
    if (qualify?.worstSeverity === 'exit' || qualify?.worstSeverity === 'degrade') {
      return 'skip';
    }
    return 'buy';
  }

  if (isWatchStatus) return 'watch';
  return 'skip';
}

async function evaluateCandidate({
  position,
  target,
  forcedStrategy,
  dataClient,
  eventIntervals,
  ohlcv,
  indicators,
  includeCandles,
  minScore,
}) {
  const { evaluation, warnings } = await buildEvaluation({
    position,
    dataClient,
    eventIntervals,
    ohlcv,
    indicators,
    includeCandles,
  });

  if (evaluation && !Array.isArray(evaluation.warnings)) evaluation.warnings = warnings || [];

  const symbol =
    evaluation?.symbol ||
    evaluation?.coin?.symbol ||
    evaluation?.token?.symbol ||
    target?.symbol ||
    null;
  if (evaluation && symbol && !evaluation.symbol) evaluation.symbol = symbol;

  const chosen = forcedStrategy
    ? { strategy: forcedStrategy, source: 'wallet' }
    : chooseStrategy(position, STRATEGY_DOCS, evaluation);
  const skipExitabilityGate = shouldSkipExitabilityGate(position, evaluation);
  const qualify = evalQualifyForBuy(chosen.strategy, evaluation, skipExitabilityGate);

  evaluation.strategy = {
    strategyId: chosen.strategy.strategyId,
    schemaVersion: chosen.strategy.schemaVersion,
    name: chosen.strategy.name,
    source: chosen.source,
  };
  evaluation.qualify = {
    worstSeverity: qualify.worstSeverity,
    failedCount: qualify.failed.length,
    results: qualify.results,
  };

  evaluation.recommendation = recommendAction(qualify.worstSeverity);

  const decision = resolveBuyDecision(target, evaluation.qualify, minScore);
  const reasons = buildDecisionReasons(target, qualify, skipExitabilityGate, minScore);
  const regime = computeMarketRegime(evaluation);

  return {
    chosenStrategy: chosen.strategy,
    decision,
    reasons,
    evaluation,
    regime,
  };
}

/**
 * @typedef {Object} BuyOpsController
 * @property {Function} start
 * @property {Function} stop
 */

/**
 * Create a BuyOps controller that schedules target-list + targetscan + evaluation loops.
 *
 * @param {Object} payload
 * @param {Object} tools
 * @param {Object} log
 * @returns {BuyOpsController}
 */
function createBuyOpsController(payload = {}, tools = {}, log) {
  const logger = log || console;
  const env = tools.env || process.env;

  const targetListIntervalMs = parseIntervalMs(
    payload.targetListIntervalMs ?? env.WARCHEST_TARGET_LIST_INTERVAL_MS,
    DEFAULT_TARGET_LIST_INTERVAL_MS
  );
  const targetScanIntervalMs = parseIntervalMs(
    payload.targetScanIntervalMs,
    DEFAULT_TARGET_SCAN_INTERVAL_MS
  );
  const scanConcurrency = Number.isFinite(Number(payload.scanConcurrency))
    ? Math.max(1, Number(payload.scanConcurrency))
    : DEFAULT_TARGET_SCAN_CONCURRENCY;
  const minScore = Number.isFinite(Number(payload.minScore))
    ? Number(payload.minScore)
    : DEFAULT_MIN_BUY_SCORE;

  let dataClient = null;
  let targetListTimer = null;
  let targetScanTimer = null;
  let runningTargetList = false;
  let runningTargetScan = false;
  let stopped = false;

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

  async function runTargetListTick() {
    if (runningTargetList || stopped) return;
    runningTargetList = true;
    try {
      await runTargetListOnce({ dataClient, skipTargetScan: true });
    } catch (err) {
      logger.warn(`[buyOps] target list tick failed: ${err?.message || err}`);
    } finally {
      runningTargetList = false;
    }
  }

  async function runTargetScanTick() {
    if (runningTargetScan || stopped) return;
    runningTargetScan = true;
    try {
      const hasBootyBox = await ensureBootyBox();
      if (!hasBootyBox || typeof BootyBox.listTargetsForScan !== 'function') {
        logger.warn('[buyOps] listTargetsForScan unavailable; skipping targetscan.');
        return;
      }

      const scanTargets = BootyBox.listTargetsForScan({ statuses: SCAN_STATUSES });
      const mints = scanTargets.map((row) => row && row.mint).filter(Boolean);
      if (!mints.length) {
        logger.debug?.('[buyOps] targetscan skipped: no targets');
      } else {
        await runTargetScan({
          mints,
          concurrency: scanConcurrency,
          client: dataClient,
        });
      }

      await runEvaluationTick();
    } catch (err) {
      logger.warn(`[buyOps] targetscan tick failed: ${err?.message || err}`);
    } finally {
      runningTargetScan = false;
    }
  }

  async function runEvaluationTick() {
    const wallet = loadDefaultFundingWallet();
    if (!wallet) {
      logger.warn('[buyOps] default funding wallet missing; skipping evaluation.');
      return;
    }

    const walletStrategyRaw = wallet.strategy || wallet.strategyId || wallet.strategy_id || null;
    const walletStrategyDoc = resolveStrategyOverride(walletStrategyRaw);
    if (walletStrategyRaw && !walletStrategyDoc) {
      logger.warn(`[buyOps] wallet strategy "${walletStrategyRaw}" did not match known strategies; falling back to inference.`);
    }

    if (typeof BootyBox.listTargetsByPriority !== 'function') {
      logger.warn('[buyOps] listTargetsByPriority unavailable; skipping evaluation.');
      return;
    }

    const targets = BootyBox.listTargetsByPriority({ statuses: EVAL_STATUSES });
    if (!targets.length) return;

    const openPositions = typeof BootyBox.loadOpenPositions === 'function'
      ? BootyBox.loadOpenPositions(wallet.alias)
      : { rows: [] };
    const openRows = Array.isArray(openPositions?.rows) ? openPositions.rows : [];
    const openByMint = new Map(openRows.map((row) => [normalizeMint(row.coin_mint), row]));

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

      try {
        const evalResult = await evaluateCandidate({
          position,
          target,
          forcedStrategy: walletStrategyDoc || null,
          dataClient,
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
          minScore,
        });

        if (!walletStrategyDoc && !targetStrategyDoc && evalResult?.chosenStrategy?.name) {
          const update = buildTargetStrategyUpdate(target, evalResult.chosenStrategy);
          if (update && typeof BootyBox.addUpdateTarget === 'function') {
            try {
              BootyBox.addUpdateTarget(update);
            } catch (err) {
              logger.warn(`[buyOps] failed to persist target strategy for ${mint}: ${err?.message || err}`);
            }
          }
        }

        if (
          evalResult.decision === 'buy' &&
          evalResult?.evaluation?.strategy?.name &&
          position?.positionId &&
          typeof BootyBox.updatePositionStrategyName === 'function'
        ) {
          try {
            BootyBox.updatePositionStrategyName({
              positionId: position.positionId,
              strategyName: evalResult.evaluation.strategy.name,
            });
          } catch (err) {
            logger.warn(`[buyOps] failed to update position strategy for ${mint}: ${err?.message || err}`);
          }
        }

        const snapshot = {
          ts: Date.now(),
          walletId: wallet.walletId,
          walletAlias: wallet.alias,
          tradeUuid: position.tradeUuid || null,
          mint,
          decision: evalResult.decision,
          reasons: evalResult.reasons,
          regime: evalResult.regime,
          evaluation: evalResult.evaluation,
        };

        persistBuyOpsEvaluation({
          bootyBox: BootyBox,
          target,
          snapshot,
          logger,
        });
      } catch (err) {
        logger.warn(`[buyOps] evaluation failed mint=${mint}: ${err?.message || err}`);
      }
    }
  }

  async function start() {
    await ensureBootyBox();
    dataClient = createSolanaTrackerDataClient();

    if (targetListIntervalMs != null) {
      await runTargetListTick();
      targetListTimer = setInterval(runTargetListTick, targetListIntervalMs);
    } else {
      logger.info('[buyOps] target list interval disabled.');
    }

    if (targetScanIntervalMs != null) {
      await runTargetScanTick();
      targetScanTimer = setInterval(runTargetScanTick, targetScanIntervalMs);
    } else {
      logger.info('[buyOps] target scan interval disabled.');
    }

    return {
      status: 'started',
      targetListIntervalMs,
      targetScanIntervalMs,
      minScore,
      scanConcurrency,
    };
  }

  async function stop(reason) {
    stopped = true;
    if (targetListTimer) clearInterval(targetListTimer);
    if (targetScanTimer) clearInterval(targetScanTimer);
    if (dataClient && typeof dataClient.close === 'function') {
      try {
        await dataClient.close();
      } catch (err) {
        logger.warn(`[buyOps] data client close failed: ${err?.message || err}`);
      }
    }
    return { status: 'stopped', reason: reason || null };
  }

  return { start, stop };
}

module.exports = {
  createBuyOpsController,
};
