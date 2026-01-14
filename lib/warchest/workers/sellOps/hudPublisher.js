"use strict";

const {
  buildHudChart,
  buildHudIndicators,
  buildHudMetrics,
} = require("../../../analysis/evaluationHudAdapter");

/**
 * Send a structured IPC message to the parent process (warchest daemon/HUD).
 * No-op when not running under a worker harness.
 * @param {string} type
 * @param {any} payload
 * @param {Function} [sendFn]
 */
function emitToParent(type, payload, sendFn) {
  // Worker processes launched by the harness can send structured messages to the parent.
  // The parent (warchest daemon/HUD) can forward these to the HUD renderer.
  const sender =
    typeof sendFn === "function"
      ? sendFn
      : typeof process.send === "function"
      ? process.send.bind(process)
      : null;
  if (typeof sender === "function") {
    sender({ type, payload });
  }
}

/**
 * Build the HUD payload for a SellOps evaluation snapshot.
 * @param {Object} snapshot
 * @param {number} snapshot.ts
 * @param {string} snapshot.walletAlias
 * @param {string|null} snapshot.tradeUuid
 * @param {string} snapshot.mint
 * @param {any} snapshot.evaluation
 * @param {any} snapshot.regime
 * @param {string[]} snapshot.reasons
 * @param {'hold'|'trim'|'exit'} snapshot.decision
 * @returns {any}
 */
function buildHudPayload(snapshot) {
  const evaluation = snapshot.evaluation || {};

  const friendly = snapshot.friendly || null;

  const token = (friendly && friendly.token) || evaluation.symbol || null;

  const recommendation =
    (friendly && friendly.recommendation) ||
    evaluation.recommendation ||
    snapshot.decision ||
    "hold";

  const worstSeverity =
    (friendly && friendly.worstSeverity) ||
    evaluation?.qualify?.worstSeverity ||
    null;

  const warningsCount = Number.isFinite(Number(friendly?.warningsCount))
    ? friendly.warningsCount
    : Array.isArray(evaluation.warnings)
    ? evaluation.warnings.length
    : 0;

  const gateFailures = Array.isArray(friendly?.gateFailures)
    ? friendly.gateFailures
    : [];

  const headline =
    friendly && friendly.headline
      ? friendly.headline
      : `${token || "token"} -> ${String(recommendation).toUpperCase()}`;

  const details = friendly && friendly.details ? friendly.details : null;

  // Human-readable metrics line (separate from structured metrics object)
  const metricsLine = friendly && friendly.metrics ? friendly.metrics : null;
  // Back-compat alias (some older renderers may still read metricsText)
  const metricsText = metricsLine;

  const statusLine = headline
    ? `${headline}${details ? " • " + details : ""}`
    : null;

  const state = {
    roiPct: evaluation?.derived?.roiUnrealizedPct ?? null,
    uPnlUsd:
      evaluation?.pnl?.unrealized_usd ?? evaluation?.pnl?.unrealizedUsd ?? null,
    risk: worstSeverity || "none",
    rec: recommendation || "hold",

    // Hard stop info
    hardStopPct: snapshot?.riskControls?.hardStopLossPct ?? null,
    hardStopDistancePct: snapshot?.riskControls?.stopLossDistancePct ?? null,
    hardStopEligible: snapshot?.riskControls?.stopLossEligible === true,

    // Trailing stop info
    trailingActive: snapshot?.riskControls?.trailing?.active === true,
    trailingActivationPct:
      snapshot?.riskControls?.trailing?.activationPct ?? null,
    trailingTrailPct: snapshot?.riskControls?.trailing?.trailPct ?? null,
    trailingStopUsd: snapshot?.riskControls?.trailing?.stopUsd ?? null,
    trailingHighUsd: snapshot?.riskControls?.trailing?.highWaterUsd ?? null,
    priceUsd:
      snapshot?.riskControls?.trailing?.priceUsd ??
      evaluation?.coin?.priceUsd ??
      evaluation?.coin?.price_usd ??
      null,

    // Compact "why"
    gateFailCount: evaluation?.qualify?.failedCount ?? null,
    gateFailIds: Array.isArray(gateFailures)
      ? gateFailures.map((g) => g.id).slice(0, 2)
      : [],
    warningsCount,
  };

  return {
    ts: snapshot.ts,
    walletAlias: snapshot.walletAlias,
    tradeUuid: snapshot.tradeUuid,
    mint: snapshot.mint,
    token,
    symbol: evaluation.symbol || null,
    strategy: evaluation.strategy || null,
    qualify: evaluation.qualify
      ? {
          worstSeverity: evaluation.qualify.worstSeverity,
          failedCount: evaluation.qualify.failedCount,
        }
      : null,
    decision: snapshot.decision,
    recommendation,
    worstSeverity,
    reasons: snapshot.reasons,
    regime: snapshot.regime,
    chart: buildHudChart(evaluation),
    metrics: buildHudMetrics(evaluation),
    indicators: buildHudIndicators(evaluation),
    warnings: evaluation.warnings || [],
    warningsCount,
    gateFailures,
    headline,
    details,
    statusLine,
    state,
    metricsLine,
    metricsText,
    riskControls: snapshot.riskControls || null,
  };
}

module.exports = {
  buildHudPayload,
  emitToParent,
};
