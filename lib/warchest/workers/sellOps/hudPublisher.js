'use strict';

const { buildHudChart, buildHudIndicators, buildHudMetrics } = require('./indicatorAdapter');

/**
 * Send a structured IPC message to the parent process (warchest daemon/HUD).
 * No-op when not running under a worker harness.
 * @param {string} type
 * @param {any} payload
 * @param {Function} [sendFn]
 */
function emitToParent(type, payload, sendFn = process.send) {
  // Worker processes launched by the harness can send structured messages to the parent.
  // The parent (warchest daemon/HUD) can forward these to the HUD renderer.
  if (typeof sendFn === 'function') {
    sendFn({ type, payload });
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
  return {
    ts: snapshot.ts,
    walletAlias: snapshot.walletAlias,
    tradeUuid: snapshot.tradeUuid,
    mint: snapshot.mint,
    symbol: evaluation.symbol || null,
    strategy: evaluation.strategy || null,
    qualify: evaluation.qualify
      ? { worstSeverity: evaluation.qualify.worstSeverity, failedCount: evaluation.qualify.failedCount }
      : null,
    decision: snapshot.decision,
    recommendation: evaluation.recommendation || 'hold',
    reasons: snapshot.reasons,
    regime: snapshot.regime,
    chart: buildHudChart(evaluation),
    metrics: buildHudMetrics(evaluation),
    indicators: buildHudIndicators(evaluation),
    warnings: evaluation.warnings || [],
  };
}

module.exports = {
  buildHudPayload,
  emitToParent,
};
