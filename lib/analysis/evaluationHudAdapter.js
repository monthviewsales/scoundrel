"use strict";

/**
 * Build a HUD-friendly metrics payload from an evaluation snapshot.
 *
 * @param {any} evaluation
 * @returns {{ priceUsd: number|null, liquidityUsd: number|null, unrealizedUsd: number|null, totalUsd: number|null, roiUnrealizedPct: number|null }}
 */
function buildHudMetrics(evaluation) {
  return {
    priceUsd: evaluation?.coin?.priceUsd ?? evaluation?.coin?.price_usd ?? null,
    liquidityUsd:
      evaluation?.pool?.liquidity_usd ?? evaluation?.coin?.liquidityUsd ?? null,
    unrealizedUsd: evaluation?.pnl?.unrealized_usd ?? null,
    totalUsd: evaluation?.pnl?.total_usd ?? null,
    roiUnrealizedPct: evaluation?.derived?.roiUnrealizedPct ?? null,
  };
}

/**
 * Build a HUD-friendly indicator payload from an evaluation snapshot.
 *
 * @param {any} evaluation
 * @returns {{ rsi: number|null, atr: number|null, emaFast: number|null, emaSlow: number|null, macdHist: number|null, vwap: number|null, vwapVolume: number|null }}
 */
function buildHudIndicators(evaluation) {
  const ind = evaluation?.indicators || {};
  return {
    rsi: ind.rsi ?? null,
    atr: ind.atr ?? null,
    emaFast: ind.emaFast ?? null,
    emaSlow: ind.emaSlow ?? null,
    macdHist: ind.macd?.hist ?? null,
    vwap: ind.vwap ?? null,
    vwapVolume: ind.vwapVolume ?? null,
  };
}

/**
 * Build a HUD-friendly chart payload from an evaluation snapshot.
 *
 * @param {any} evaluation
 * @returns {{ type: string, points: number, poolAddress: string|null, timeFrom: number|null, timeTo: number|null }|null}
 */
function buildHudChart(evaluation) {
  if (!evaluation?.chart) return null;
  return {
    type: evaluation.chart.type,
    points: evaluation.chart.points,
    poolAddress: evaluation.chart.poolAddress,
    timeFrom: evaluation.chart.timeFrom,
    timeTo: evaluation.chart.timeTo,
  };
}

module.exports = {
  buildHudChart,
  buildHudIndicators,
  buildHudMetrics,
};
