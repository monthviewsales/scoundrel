'use strict';

/**
 * Normalize indicator values to finite numbers.
 *
 * @param {any} value
 * @returns {number|null}
 */
function toIndicatorNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Compute a lightweight market regime label from evaluation indicators.
 *
 * This is intentionally simple and explainable. Strategies should treat this as
 * supporting context, not a single source of truth.
 *
 * @param {any} evaluation
 * @returns {{ status: 'trend_up'|'trend_down'|'bias_up'|'bias_down'|'chop'|'unknown', reasons: string[] }}
 */
function computeMarketRegime(evaluation) {
  const ind = evaluation?.indicators || null;
  const chart = evaluation?.chart || null;

  if (!ind || !chart) {
    return { status: 'unknown', reasons: ['missing_indicators_or_chart'] };
  }

  const last = toIndicatorNumber(ind.lastClose);
  const emaFast = toIndicatorNumber(ind.emaFast);
  const emaSlow = toIndicatorNumber(ind.emaSlow);
  const rsi = toIndicatorNumber(ind.rsi);
  const atr = toIndicatorNumber(ind.atr);
  const vwap = toIndicatorNumber(ind.vwap);
  const macd = ind.macd && typeof ind.macd === 'object' ? ind.macd : null;

  const reasons = [];

  // Trend
  let trend = 'unknown';
  if (emaFast != null && emaSlow != null) {
    if (emaFast > emaSlow) trend = 'up';
    else if (emaFast < emaSlow) trend = 'down';
    else trend = 'flat';
    reasons.push(`trend:${trend}`);
  }

  // Momentum (MACD)
  let momentum = 'unknown';
  if (macd && Number.isFinite(Number(macd.hist))) {
    const h = Number(macd.hist);
    momentum = h > 0 ? 'bullish' : h < 0 ? 'bearish' : 'neutral';
    reasons.push(`macd:${momentum}`);
  }

  // RSI bands
  if (rsi != null) {
    if (rsi >= 70) reasons.push('rsi:overbought');
    else if (rsi <= 30) reasons.push('rsi:oversold');
    else reasons.push('rsi:mid');
  }

  // Price vs VWAP
  if (last != null && vwap != null) {
    if (last > vwap) reasons.push('price>vwap');
    else if (last < vwap) reasons.push('price<vwap');
    else reasons.push('price=vwap');
  }

  // Volatility (ATR relative)
  if (last != null && atr != null && last !== 0) {
    const atrPct = (atr / last) * 100;
    if (Number.isFinite(atrPct)) {
      reasons.push(`atrPct:${atrPct.toFixed(2)}`);
    }
  }

  // Regime label (simple)
  let status = 'chop';
  if (trend === 'up' && momentum === 'bullish') status = 'trend_up';
  else if (trend === 'down' && momentum === 'bearish') status = 'trend_down';
  else if (trend === 'up' && momentum !== 'bearish') status = 'bias_up';
  else if (trend === 'down' && momentum !== 'bullish') status = 'bias_down';

  return { status, reasons };
}

module.exports = {
  computeMarketRegime,
  toIndicatorNumber,
};
