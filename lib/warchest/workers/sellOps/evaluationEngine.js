'use strict';

const { chooseStrategy, evalQualify, recommendAction } = require('./decisionEngine');

// Coin freshness guardrail (how stale is too stale)
const MAX_COIN_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_POOL_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_EVENTS_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_RISK_STALE_MS = 10 * 60 * 1000; // 10 minutes

const DEFAULT_EVENT_INTERVALS = ['5m', '15m', '1h'];

/**
 * Build a full evaluation snapshot and return a decision scaffold.
 *
 * Phase 1 (current): always returns decision='hold' and emits rich diagnostics.
 * Phase 2+: strategy engine will:
 *  - resolve/assign strategy per position (DB strategy_id/strategy_name or inference)
 *  - apply eligibility gates (risk/structure + liquidity + freshness)
 *  - apply exit logic (partials, trailing stops, hard invalidations)
 *  - optionally recommend sizing and/or enforce post-entry de-risk trims
 *
 * @param {Object} args
 * @param {Object} args.position
 * @param {any} args.db
 * @param {any} args.dataClient
 * @param {string[]} [args.eventIntervals]
 * @param {any} [args.payload]
 * @param {{ flash: object, hybrid: object, campaign: object }} args.strategyDocs
 * @param {Function} args.buildEvaluation
 * @returns {Promise<{ decision: 'hold'|'trim'|'exit', reasons: string[], evaluation: any }>}
 */
async function evaluatePosition({
  position,
  db,
  dataClient,
  eventIntervals,
  payload,
  strategyDocs,
  buildEvaluation,
}) {
  const reasons = [];

  // Build a complete, DB-backed snapshot (shared across apps)
  const { evaluation, warnings } = await buildEvaluation({
    db,
    position,
    dataClient,
    eventIntervals: eventIntervals || DEFAULT_EVENT_INTERVALS,
    freshness: {
      coin: MAX_COIN_STALE_MS,
      pool: MAX_POOL_STALE_MS,
      events: MAX_EVENTS_STALE_MS,
      risk: MAX_RISK_STALE_MS,
    },
    ohlcv: {
      type: payload?.ohlcvType || '1m',
      lookbackMs: payload?.ohlcvLookbackMs || 60 * 60 * 1000, // 60m default
      fastCache: true,
      removeOutliers: true,
    },
    indicators: {
      // VWAP over last N candles if provided; otherwise full lookback
      vwapPeriods: payload?.vwapPeriods ?? null,
    },
    includeCandles: Boolean(payload?.includeCandles),
  });

  // Ensure warnings are present on the evaluation object (strategy engine expects them).
  // buildEvaluation returns `warnings` separately for historical compatibility.
  if (evaluation && !Array.isArray(evaluation.warnings)) evaluation.warnings = warnings || [];

  // Best-effort symbol for logs/HUD (prefer evaluation coin meta, then position fields).
  const symbol =
    (evaluation && (evaluation.symbol || evaluation.coin?.symbol || evaluation.token?.symbol)) ||
    position?.symbol ||
    position?.coinSymbol ||
    null;

  // Attach symbol onto the evaluation snapshot so downstream doesn't need to re-derive it.
  if (evaluation && symbol && !evaluation.symbol) evaluation.symbol = symbol;

  // Strategy selection + qualify evaluation (Phase 1.5: observe only).
  const chosen = chooseStrategy(position, strategyDocs, evaluation);
  const qualify = chosen.qualify || evalQualify(chosen.strategy, evaluation);

  // Attach strategy metadata and gate outcomes for HUD, logs, and eventual autopsy embedding.
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

  // Non-executing recommendation derived from strategy qualify results.
  // This is surfaced to the HUD only.
  const recommendation = recommendAction(qualify.worstSeverity);
  evaluation.recommendation = recommendation;
  reasons.push(`recommend:${recommendation}`);

  // Add human-readable reasons for visibility (no execution yet).
  reasons.push(`strategy:${evaluation.strategy.name}`);
  reasons.push(`strategySource:${evaluation.strategy.source}`);
  if (qualify.failed.length) {
    reasons.push(`qualifyFailed:${qualify.failed.length}`);
    for (const f of qualify.failed.slice(0, 5)) {
      reasons.push(`gateFail:${f.id}:${f.severityOnFail}`);
    }
    if (qualify.worstSeverity === 'degrade') {
      reasons.push('posture:degrade');
    }
  } else {
    reasons.push('qualify:pass');
  }

  // For now we do not take action. Phase 2 will score and pick buy/hold/sell.
  const decision = 'hold';

  if (!warnings || !warnings.length) {
    reasons.push('evaluation_ready');
  } else {
    reasons.push('evaluation_partial');
  }

  return { decision, reasons, evaluation };
}

module.exports = {
  DEFAULT_EVENT_INTERVALS,
  evaluatePosition,
};
