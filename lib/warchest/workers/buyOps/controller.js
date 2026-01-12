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

  const chosen = chooseStrategy(position, STRATEGY_DOCS, evaluation);
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
      const position = openRow
        ? toPositionSummary(openRow)
        : {
            walletId: wallet.walletId,
            walletAlias: wallet.alias,
            mint,
            tradeUuid: null,
            strategyId: target.strategy_id || null,
            strategyName: target.strategy || null,
            currentTokenAmount: null,
            source: 'buyOps',
          };

      try {
        const evalResult = await evaluateCandidate({
          position,
          target,
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
