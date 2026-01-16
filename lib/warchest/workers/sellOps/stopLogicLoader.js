"use strict";

const { getPath } = require("./decisionEngine");

const DEFAULT_TRAIL_POLL_MS = 5_000;
const DEFAULT_TRAIL_ACTIVATION_PCT = 8;
const DEFAULT_TRAIL_PCT = 7;
const DEFAULT_BREACH_CONFIRMATIONS = 2;
const DEFAULT_ACTION_DEBOUNCE_MS = 30_000;
const DEFAULT_HARD_STOP_LOSS_PCT = 17;

/**
 * Safely pull trailing stop config from a strategy doc.
 * We keep this permissive because schemas may evolve.
 * @param {Object} strategy
 * @returns {{ activationPct: number, trailPct: number, pollMs: number, breachConfirmations: number, actionDebounceMs: number, hardStopLossPct: number }}
 */
function getTrailingStopConfig(strategy) {
  const manage = (strategy && strategy.manage) || {};
  const defaults = (strategy && strategy.defaults) || {};
  // Allow a few possible shapes without being brittle.
  const manageTrailing =
    (manage &&
      (manage.trailingStop || manage.trailing_stop || manage.trailing)) ||
    {};
  const defaultsTrailing =
    (defaults &&
      (defaults.trailingStop || defaults.trailing_stop || defaults.trailing)) ||
    {};

  const readNumeric = (...values) => {
    for (const value of values) {
      if (Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  };

  const activationPct =
    readNumeric(
      manageTrailing.activationPct,
      manageTrailing.minProfitToEnablePct,
      defaultsTrailing.activationPct,
      defaultsTrailing.minProfitToEnablePct
    ) ?? DEFAULT_TRAIL_ACTIVATION_PCT;
  const trailPct =
    readNumeric(manageTrailing.trailPct, defaultsTrailing.trailPct) ??
    DEFAULT_TRAIL_PCT;
  const pollMs =
    readNumeric(manageTrailing.pollMs, defaultsTrailing.pollMs) ??
    DEFAULT_TRAIL_POLL_MS;
  const breachConfirmations =
    readNumeric(
      manageTrailing.breachConfirmations,
      defaultsTrailing.breachConfirmations
    ) ?? DEFAULT_BREACH_CONFIRMATIONS;
  const actionDebounceMs =
    readNumeric(
      manageTrailing.actionDebounceMs,
      defaultsTrailing.actionDebounceMs
    ) ?? DEFAULT_ACTION_DEBOUNCE_MS;
  const hardStopLossPct =
    readNumeric(
      manageTrailing.hardStopLossPct,
      defaultsTrailing.hardStopLossPct,
      defaults.hardStopLossPct
    ) ?? DEFAULT_HARD_STOP_LOSS_PCT;

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
  const fromEval = Number(getPath(evaluation, "pnl.avg_cost_usd"));
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
