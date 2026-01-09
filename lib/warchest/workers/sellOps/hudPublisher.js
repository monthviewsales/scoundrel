'use strict';

const { buildHudChart, buildHudIndicators, buildHudMetrics } = require('./indicatorAdapter');

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
  const sender = typeof sendFn === 'function'
    ? sendFn
    : (typeof process.send === 'function' ? process.send.bind(process) : null);
  if (typeof sender === 'function') {
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
    'hold';

  const worstSeverity =
    (friendly && friendly.worstSeverity) ||
    evaluation?.qualify?.worstSeverity ||
    null;

  const warningsCount = Number.isFinite(Number(friendly?.warningsCount))
    ? friendly.warningsCount
    : (Array.isArray(evaluation.warnings) ? evaluation.warnings.length : 0);

  const gateFailures = Array.isArray(friendly?.gateFailures) ? friendly.gateFailures : [];

  const headline = (friendly && friendly.headline)
    ? friendly.headline
    : `${token || 'token'} -> ${String(recommendation).toUpperCase()}`;

  const details = (friendly && friendly.details) ? friendly.details : null;

  // Human-readable metrics line (separate from structured metrics object)
  const metricsLine = (friendly && friendly.metrics) ? friendly.metrics : null;
  // Back-compat alias (some older renderers may still read metricsText)
  const metricsText = metricsLine;

  return {
    ts: snapshot.ts,
    walletAlias: snapshot.walletAlias,
    tradeUuid: snapshot.tradeUuid,
    mint: snapshot.mint,
    token,
    symbol: evaluation.symbol || null,
    strategy: evaluation.strategy || null,
    qualify: evaluation.qualify
      ? { worstSeverity: evaluation.qualify.worstSeverity, failedCount: evaluation.qualify.failedCount }
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
    metricsLine,
    metricsText,
    riskControls: snapshot.riskControls || null,
  };
}

module.exports = {
  buildHudPayload,
  emitToParent,
};
