'use strict';

/**
 * Compute the Relative Strength Index (RSI) for a series of closes.
 *
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function computeRsi(closes, period) {
  const p = Math.max(1, Number(period || 14));
  if (!Array.isArray(closes) || closes.length < p + 1) return null;

  let gains = 0;
  let losses = 0;

  // Seed with first p deltas
  for (let i = 1; i <= p; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }

  let avgGain = gains / p;
  let avgLoss = losses / p;

  // Wilder smoothing over remaining points
  for (let i = p + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;

    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number.isFinite(rsi) ? rsi : null;
}

/**
 * Compute the Average True Range (ATR) for a series of candles.
 *
 * @param {{ h: number, l: number, c: number }[]} candles
 * @param {number} period
 * @returns {number|null}
 */
function computeAtr(candles, period) {
  const p = Math.max(1, Number(period || 14));
  if (!Array.isArray(candles) || candles.length < p + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    trs.push(tr);
  }

  if (trs.length < p) return null;

  // Wilder ATR smoothing
  let atr = 0;
  for (let i = 0; i < p; i++) atr += trs[i];
  atr /= p;

  for (let i = p; i < trs.length; i++) {
    atr = (atr * (p - 1) + trs[i]) / p;
  }

  return Number.isFinite(atr) ? atr : null;
}

/**
 * Compute the slope (percent per candle) for a series of closes.
 *
 * @param {number[]} closes
 * @param {number} periods
 * @returns {number|null}
 */
function computeSlopePct(closes, periods) {
  const n = Math.max(2, Number(periods || 30));
  if (!Array.isArray(closes) || closes.length < n) return null;

  const slice = closes.slice(-n);
  const xs = [];
  const ys = slice;
  for (let i = 0; i < slice.length; i++) xs.push(i);

  const meanX = (xs.reduce((a, b) => a + b, 0)) / xs.length;
  const meanY = (ys.reduce((a, b) => a + b, 0)) / ys.length;

  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }

  if (!den) return null;
  const slope = num / den; // price units per candle

  const base = ys[0] || 0;
  if (!base) return null;

  // Convert to % change per candle relative to starting price.
  const slopePct = (slope / base) * 100;
  return Number.isFinite(slopePct) ? slopePct : null;
}

/**
 * Compute the last EMA value for a series.
 *
 * @param {number[]} values
 * @param {number} period
 * @returns {number|null}
 */
function computeEmaSeries(values, period) {
  const p = Math.max(1, Number(period || 12));
  if (!Array.isArray(values) || values.length < p) return null;

  // Seed EMA with SMA of first p values
  let sma = 0;
  for (let i = 0; i < p; i++) sma += values[i];
  sma /= p;

  const k = 2 / (p + 1);
  let ema = sma;

  for (let i = p; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return Number.isFinite(ema) ? ema : null;
}

/**
 * Compute EMA values aligned to the input series (null until seed).
 *
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]|null}
 */
function computeEmaSeriesAll(values, period) {
  const p = Math.max(1, Number(period || 12));
  if (!Array.isArray(values) || values.length < p) return null;

  // Seed EMA with SMA of first p values
  let sma = 0;
  for (let i = 0; i < p; i++) sma += values[i];
  sma /= p;

  const k = 2 / (p + 1);
  let ema = sma;
  const out = [];

  // Output aligned to input indices: null until we have a seed.
  for (let i = 0; i < p - 1; i++) out.push(null);
  out.push(ema);

  for (let i = p; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }

  return out;
}

/**
 * Compute MACD (macd/signal/hist) for a series of closes.
 *
 * @param {number[]} closes
 * @param {number} fastPeriod
 * @param {number} slowPeriod
 * @param {number} signalPeriod
 * @returns {{ macd: number|null, signal: number|null, hist: number|null }|null}
 */
function computeMacd(closes, fastPeriod, slowPeriod, signalPeriod) {
  const fast = Math.max(1, Number(fastPeriod || 12));
  const slow = Math.max(1, Number(slowPeriod || 26));
  const signal = Math.max(1, Number(signalPeriod || 9));

  if (!Array.isArray(closes) || closes.length < slow + signal) return null;

  const emaFastAll = computeEmaSeriesAll(closes, fast);
  const emaSlowAll = computeEmaSeriesAll(closes, slow);
  if (!emaFastAll || !emaSlowAll) return null;

  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFastAll[i];
    const s = emaSlowAll[i];
    macdLine.push(f != null && s != null ? (f - s) : null);
  }

  // Build signal EMA over macdLine where defined
  const macdDefined = macdLine.filter((v) => v != null);
  if (macdDefined.length < signal) return null;

  // Compute signal EMA across defined macd points (latest value)
  const signalValue = computeEmaSeries(macdDefined, signal);
  const lastMacd = macdDefined[macdDefined.length - 1];

  if (signalValue == null || lastMacd == null) return null;

  const hist = lastMacd - signalValue;

  return {
    macd: Number.isFinite(lastMacd) ? lastMacd : null,
    signal: Number.isFinite(signalValue) ? signalValue : null,
    hist: Number.isFinite(hist) ? hist : null,
  };
}

/**
 * Compute VWAP + summed volume from candles.
 *
 * @param {{ h: number, l: number, c: number, v?: number }[]} candles
 * @param {number|null} periods
 * @returns {{ vwap: number|null, volume: number|null }}
 */
function computeVwap(candles, periods) {
  if (!Array.isArray(candles) || candles.length === 0) return { vwap: null, volume: null };

  const n = periods == null ? candles.length : Math.max(1, Number(periods));
  const slice = candles.slice(-n);

  let pv = 0;
  let vSum = 0;

  for (const c of slice) {
    const v = Number.isFinite(Number(c.v)) ? Number(c.v) : 0;
    const tp = (Number(c.h) + Number(c.l) + Number(c.c)) / 3;
    if (!Number.isFinite(tp)) continue;
    pv += tp * v;
    vSum += v;
  }

  if (!vSum) return { vwap: null, volume: 0 };

  const vwap = pv / vSum;
  return {
    vwap: Number.isFinite(vwap) ? vwap : null,
    volume: vSum,
  };
}

module.exports = {
  computeRsi,
  computeAtr,
  computeSlopePct,
  computeEmaSeries,
  computeEmaSeriesAll,
  computeMacd,
  computeVwap,
};
