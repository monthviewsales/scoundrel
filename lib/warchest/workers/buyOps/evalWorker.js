'use strict';

const BootyBox = require('../../../../db');
const { createSolanaTrackerDataClient } = require('../../../solanaTrackerDataClient');
const { computeMarketRegime } = require('../../../analysis/indicators');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { buildEvaluation } = require('../../../../db/src/services/evaluationService');
const { loadStrategyDocs } = require('../sellOps/strategyDocs');
const { chooseStrategy, evalQualify, recommendAction } = require('../sellOps/decisionEngine');
const { withTimeout } = require('../warchestServiceHelpers');
const { createWorkerHarness } = require('../harness');
const { createWorkerLogger } = require('../workerLogger');

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

/**
 * Resolve the sqlite DB handle from BootyBox context.
 *
 * @returns {*}
 */
function resolveDbHandle() {
  const ctx = BootyBox.modules && BootyBox.modules.context ? BootyBox.modules.context : null;
  if (ctx && ctx.db) return ctx.db;
  if (ctx && typeof ctx.getDb === 'function') {
    return ctx.getDb();
  }
  return null;
}

/**
 * Evaluate a single buy candidate (per-mint).
 *
 * @param {Object} payload
 * @returns {Promise<{ decision: string, reasons: string[], evaluation: Object, regime: Object, chosenStrategy: Object }>}
 */
async function runBuyOpsEvaluation(payload) {
  const position = payload?.position || null;
  const target = payload?.target || null;
  if (!position || !position.mint) {
    throw new Error('buyOps evaluation requires a position with mint');
  }

  await ensureBootyBoxInit();
  const db = resolveDbHandle();
  if (!db) {
    throw new Error('buyOps evaluation requires a sqlite db handle');
  }

  const dataClient = createSolanaTrackerDataClient();
  try {
    const { evaluation, warnings } = await withTimeout(
      buildEvaluation({
        db,
        position,
        dataClient,
        eventIntervals: payload?.eventIntervals || ['5m', '15m', '1h'],
        ohlcv: payload?.ohlcv || null,
        indicators: payload?.indicators || null,
        includeCandles: Boolean(payload?.includeCandles),
      }),
      payload?.evalTimeoutMs,
      `buyOps evaluation ${position?.mint || 'mint'}`
    );

    if (evaluation && !Array.isArray(evaluation.warnings)) evaluation.warnings = warnings || [];

    const symbol =
      evaluation?.symbol ||
      evaluation?.coin?.symbol ||
      evaluation?.token?.symbol ||
      target?.symbol ||
      null;
    if (evaluation && symbol && !evaluation.symbol) evaluation.symbol = symbol;

    const forcedStrategy = resolveStrategyOverride(payload?.walletStrategyRaw);
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

    const decision = resolveBuyDecision(target, evaluation.qualify, Number(payload?.minScore));
    const reasons = buildDecisionReasons(target, qualify, skipExitabilityGate, Number(payload?.minScore));
    const regime = computeMarketRegime(evaluation);

    return {
      chosenStrategy: chosen.strategy,
      decision,
      reasons,
      evaluation,
      regime,
    };
  } finally {
    if (dataClient && typeof dataClient.close === 'function') {
      try {
        await dataClient.close();
      } catch (err) {
        // best-effort cleanup
      }
    }
  }
}

if (require.main === module) {
  const logger = createWorkerLogger({
    workerName: 'buyOpsEvalWorker',
    scope: 'buyOps',
  });
  createWorkerHarness(runBuyOpsEvaluation, {
    workerName: 'buyOpsEval',
    logger,
  });
} else {
  createWorkerHarness(runBuyOpsEvaluation, {
    workerName: 'buyOpsEval',
  });
}

module.exports = {
  runBuyOpsEvaluation,
};
