'use strict';

const { getPath } = require('./decisionEngine');

const DEFAULT_TRAIL_POLL_MS = 5_000;
const DEFAULT_TRAIL_ACTIVATION_PCT = 10;
const DEFAULT_TRAIL_PCT = 8;
const DEFAULT_BREACH_CONFIRMATIONS = 2;
const DEFAULT_ACTION_DEBOUNCE_MS = 30_000;
const DEFAULT_HARD_STOP_LOSS_PCT = 25;

/**
 * Safely pull trailing stop config from a strategy doc.
 * We keep this permissive because schemas may evolve.
 * @param {Object} strategy
 * @returns {{ activationPct: number, trailPct: number, pollMs: number, breachConfirmations: number, actionDebounceMs: number, hardStopLossPct: number }}
 */
function getTrailingStopConfig(strategy) {
  const d = (strategy && strategy.defaults) || {};
  // Allow a few possible shapes without being brittle.
  const ts = (d && (d.trailingStop || d.trailing_stop || d.trailing)) || {};

  const activationPct = Number.isFinite(Number(ts.activationPct)) ? Number(ts.activationPct) : DEFAULT_TRAIL_ACTIVATION_PCT;
  const trailPct = Number.isFinite(Number(ts.trailPct)) ? Number(ts.trailPct) : DEFAULT_TRAIL_PCT;
  const pollMs = Number.isFinite(Number(ts.pollMs)) ? Number(ts.pollMs) : DEFAULT_TRAIL_POLL_MS;
  const breachConfirmations = Number.isFinite(Number(ts.breachConfirmations))
    ? Number(ts.breachConfirmations)
    : DEFAULT_BREACH_CONFIRMATIONS;
  const actionDebounceMs = Number.isFinite(Number(ts.actionDebounceMs)) ? Number(ts.actionDebounceMs) : DEFAULT_ACTION_DEBOUNCE_MS;
  const hardStopLossPct = Number.isFinite(Number(ts.hardStopLossPct))
    ? Number(ts.hardStopLossPct)
    : Number.isFinite(Number(d.hardStopLossPct))
      ? Number(d.hardStopLossPct)
      : DEFAULT_HARD_STOP_LOSS_PCT;

  return {
    activationPct,
    trailPct,
    pollMs,
    breachConfirmations,
    actionDebounceMs,
    hardStopLossPct,
  };
}

/**
 * Best-effort cost basis in USD for a position.
 * Prefer evaluation.pnl.avg_cost_usd, then position.entryPriceUsd.
 * @param {Object} position
 * @param {any} evaluation
 * @returns {number|null}
 */
function resolveAvgCostUsd(position, evaluation) {
  const fromEval = Number(getPath(evaluation, 'pnl.avg_cost_usd'));
  if (Number.isFinite(fromEval) && fromEval > 0) return fromEval;

  const fromPos = Number(position?.entryPriceUsd);
  if (Number.isFinite(fromPos) && fromPos > 0) return fromPos;

  return null;
}

module.exports = {
  DEFAULT_ACTION_DEBOUNCE_MS,
  DEFAULT_BREACH_CONFIRMATIONS,
  DEFAULT_HARD_STOP_LOSS_PCT,
  DEFAULT_TRAIL_ACTIVATION_PCT,
  DEFAULT_TRAIL_PCT,
  DEFAULT_TRAIL_POLL_MS,
  getTrailingStopConfig,
  resolveAvgCostUsd,
};
