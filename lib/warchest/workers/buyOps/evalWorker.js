'use strict';

const BootyBox = require('../../../../db');
const { createSolanaTrackerDataClient } = require('../../../solanaTrackerDataClient');
const { computeMarketRegime } = require('../../../analysis/indicators');
const { ensureBootyBoxInit } = require('../../../bootyBoxInit');
const { ensureTokenInfo } = require('../../../services/tokenInfoService');
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

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveStrategyChoice({ payload, position, target }) {
  const walletStrategy = resolveStrategyOverride(payload?.walletStrategyRaw);
  if (walletStrategy) {
    return { strategy: walletStrategy, source: 'wallet' };
  }

  const positionStrategy = resolveStrategyOverride(position?.strategyName || position?.strategyId);
  if (positionStrategy) {
    return { strategy: positionStrategy, source: 'position' };
  }

  const targetStrategy = resolveStrategyOverride(target?.strategy || target?.strategy_id);
  if (targetStrategy) {
    return { strategy: targetStrategy, source: 'target' };
  }

  return null;
}

function resolveExpectedNotional(strategy, payload) {
  const payloadUsd = toFiniteNumber(
    payload?.expectedNotionalUsd ?? payload?.plannedNotionalUsd ?? payload?.notionalUsd
  );
  const payloadSol = toFiniteNumber(
    payload?.expectedNotionalSol ?? payload?.plannedNotionalSol ?? payload?.notionalSol
  );

  const expectedNotionalUsd = payloadUsd != null && payloadUsd > 0 ? payloadUsd : null;
  const expectedNotionalSol = payloadSol != null && payloadSol > 0 ? payloadSol : null;

  if (expectedNotionalUsd != null || expectedNotionalSol != null) {
    return { expectedNotionalUsd, expectedNotionalSol };
  }

  const inputs = strategy?.entry?.sizing?.inputs || {};
  const baseUnitSol = toFiniteNumber(inputs.baseUnitSol);
  const strategySol = (baseUnitSol != null && baseUnitSol > 0) ? baseUnitSol : null;

  if (strategySol != null) {
    return { expectedNotionalSol: strategySol, expectedNotionalUsd: null };
  }

  return null;
}

function fingerprintExpectedNotional(expectedNotional) {
  if (!expectedNotional) return 'none';
  return JSON.stringify({
    expectedNotionalUsd: expectedNotional.expectedNotionalUsd ?? null,
    expectedNotionalSol: expectedNotional.expectedNotionalSol ?? null,
  });
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
 * Resolve evaluation inputs (freshness, intervals, indicators) from strategy defaults + payload overrides.
 *
 * @param {Object|null} strategy
 * @param {Object} payload
 * @returns {{ eventIntervals?: string[], ohlcv?: Object|null, indicators?: Object|null, freshness?: Object|null, includeCandles: boolean }}
 */
function resolveEvaluationConfig(strategy, payload) {
  const defaults = strategy?.defaults || {};
  const requirements = strategy?.dataRequirements || {};

  const eventIntervals = Array.isArray(payload?.eventIntervals) && payload.eventIntervals.length
    ? payload.eventIntervals.slice()
    : Array.isArray(defaults.eventIntervals) && defaults.eventIntervals.length
      ? defaults.eventIntervals.slice()
      : undefined;

  const ohlcv =
    (defaults.ohlcv || payload?.ohlcv)
      ? { ...(defaults.ohlcv || {}), ...(payload?.ohlcv || {}) }
      : null;

  const indicators =
    (defaults.indicators || payload?.indicators)
      ? { ...(defaults.indicators || {}), ...(payload?.indicators || {}) }
      : null;

  const freshness = payload?.freshness || requirements?.freshnessMs || null;

  return {
    eventIntervals,
    ohlcv,
    indicators,
    freshness,
    includeCandles: Boolean(payload?.includeCandles),
  };
}

function fingerprintEvaluationConfig(config) {
  return JSON.stringify({
    eventIntervals: config?.eventIntervals || null,
    ohlcv: config?.ohlcv || null,
    indicators: config?.indicators || null,
    freshness: config?.freshness || null,
    includeCandles: Boolean(config?.includeCandles),
  });
}

function applyEvaluationMetadata({ evaluation, warnings, target }) {
  if (evaluation && !Array.isArray(evaluation.warnings)) evaluation.warnings = warnings || [];

  const symbol =
    evaluation?.symbol ||
    evaluation?.coin?.symbol ||
    evaluation?.token?.symbol ||
    target?.symbol ||
    null;
  if (evaluation && symbol && !evaluation.symbol) evaluation.symbol = symbol;
}

function buildPositionForEvaluation(position, expectedNotional) {
  if (!expectedNotional) return position;
  return {
    ...position,
    ...(expectedNotional.expectedNotionalUsd != null ? { expectedNotionalUsd: expectedNotional.expectedNotionalUsd } : {}),
    ...(expectedNotional.expectedNotionalSol != null ? { expectedNotionalSol: expectedNotional.expectedNotionalSol } : {}),
  };
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
    const forceTokenRefresh = payload?.forceTokenRefresh !== false;
    if (forceTokenRefresh) {
      try {
        await ensureTokenInfo({ mint: position.mint, client: dataClient, forceRefresh: true });
      } catch (err) {
        // best-effort refresh; evaluation will still run on cached DB values
      }
    }

    const forcedStrategy = resolveStrategyChoice({ payload, position, target });
    const initialExpectedNotional = resolveExpectedNotional(forcedStrategy?.strategy || null, payload);
    const initialConfig = resolveEvaluationConfig(forcedStrategy?.strategy || null, payload);
    const initialPosition = buildPositionForEvaluation(position, initialExpectedNotional);

    const buildSnapshot = async (config, positionOverride) => {
      const args = {
        db,
        position: positionOverride || position,
        dataClient,
        eventIntervals: config.eventIntervals,
        ohlcv: config.ohlcv,
        indicators: config.indicators,
        includeCandles: config.includeCandles,
      };
      if (config.freshness) args.freshness = config.freshness;
      return withTimeout(
        buildEvaluation(args),
        payload?.evalTimeoutMs,
        `buyOps evaluation ${position?.mint || 'mint'}`
      );
    };

    let { evaluation, warnings } = await buildSnapshot(initialConfig, initialPosition);
    applyEvaluationMetadata({ evaluation, warnings, target });

    let chosen = forcedStrategy;
    if (!chosen) {
      chosen = chooseStrategy(position, STRATEGY_DOCS, evaluation);
    }

    const chosenConfig = resolveEvaluationConfig(chosen?.strategy || null, payload);
    const chosenExpectedNotional = resolveExpectedNotional(chosen?.strategy || null, payload);
    const needsConfigRefresh = fingerprintEvaluationConfig(chosenConfig) !== fingerprintEvaluationConfig(initialConfig);
    const needsNotionalRefresh = fingerprintExpectedNotional(chosenExpectedNotional) !== fingerprintExpectedNotional(initialExpectedNotional);

    if (needsConfigRefresh || needsNotionalRefresh) {
      const positionForChosen = buildPositionForEvaluation(position, chosenExpectedNotional);
      const rebuilt = await buildSnapshot(chosenConfig, positionForChosen);
      evaluation = rebuilt.evaluation;
      warnings = rebuilt.warnings;
      applyEvaluationMetadata({ evaluation, warnings, target });
      chosen = chooseStrategy(positionForChosen, STRATEGY_DOCS, evaluation);
    }

    const skipExitabilityGate = shouldSkipExitabilityGate(position, evaluation);
    const qualify = evalQualifyForBuy(chosen.strategy, evaluation, skipExitabilityGate);

    evaluation.strategy = {
      strategyId: chosen.strategy.strategyId,
      schemaVersion: chosen.strategy.schemaVersion,
      name: chosen.strategy.name,
      source: chosen.source || forcedStrategy?.source || 'inferred',
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
