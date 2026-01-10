'use strict';

const { computeMarketRegime } = require('./indicators');
const {
  computeAtr,
  computeEmaSeries,
  computeMacd,
  computeRsi,
  computeSlopePct,
  computeVwap,
} = require('../../db/src/services/indicators');

const DEFAULT_INDICATORS = {
  rsiPeriod: 14,
  atrPeriod: 14,
  slopePeriods: 30,
  emaFast: 12,
  emaSlow: 26,
  macdSignal: 9,
  vwapPeriods: null,
};

const DEFAULT_SUMMARY_WINDOWS = ['5m', '15m', '1h'];
const DEFAULT_VOLUME_PROFILE_BUCKETS = 12;

/**
 * Normalize an OHLCV row into canonical fields.
 *
 * @param {any} row
 * @returns {{ t: number|null, o: number|null, h: number|null, l: number|null, c: number|null, v: number|null }}
 */
function normalizeCandle(row) {
  const t = row?.t ?? row?.time ?? row?.ts ?? null;
  const o = row?.o ?? row?.open ?? null;
  const h = row?.h ?? row?.high ?? null;
  const l = row?.l ?? row?.low ?? null;
  const c = row?.c ?? row?.close ?? null;
  const v = row?.v ?? row?.volume ?? null;

  const toNum = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

  return {
    t: toNum(t),
    o: toNum(o),
    h: toNum(h),
    l: toNum(l),
    c: toNum(c),
    v: toNum(v),
  };
}

/**
 * Normalize a timestamp into milliseconds.
 *
 * @param {number|null} value
 * @returns {number|null}
 */
function normalizeTimestampMs(value) {
  if (!Number.isFinite(Number(value))) return null;
  const num = Number(value);
  return num < 1e12 ? num * 1000 : num;
}

/**
 * Parse a summary window spec into milliseconds.
 *
 * @param {string|number|{ label?: string, minutes?: number, windowMs?: number }} spec
 * @returns {{ label: string, windowMs: number }|null}
 */
function parseSummaryWindow(spec) {
  if (spec == null) return null;
  if (typeof spec === 'object') {
    const windowMs = Number(spec.windowMs || 0);
    if (Number.isFinite(windowMs) && windowMs > 0) {
      return { label: spec.label || `${Math.round(windowMs / 60000)}m`, windowMs };
    }
    const minutes = Number(spec.minutes || 0);
    if (Number.isFinite(minutes) && minutes > 0) {
      return { label: spec.label || `${minutes}m`, windowMs: minutes * 60000 };
    }
    return null;
  }
  if (typeof spec === 'number') {
    const minutes = Number(spec);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return { label: `${minutes}m`, windowMs: minutes * 60000 };
  }
  if (typeof spec === 'string') {
    const trimmed = spec.trim();
    const match = trimmed.match(/^(\d+)\s*([mhd])$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'h' ? 60 : unit === 'd' ? 1440 : 1;
    const minutes = amount * multiplier;
    return { label: `${amount}${unit}`, windowMs: minutes * 60000 };
  }
  return null;
}

/**
 * Normalize summary window specs.
 *
 * @param {Array} windows
 * @returns {{ label: string, windowMs: number }[]}
 */
function normalizeSummaryWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  const normalized = list
    .map(parseSummaryWindow)
    .filter(Boolean);
  return normalized.length ? normalized : DEFAULT_SUMMARY_WINDOWS.map(parseSummaryWindow).filter(Boolean);
}

/**
 * Compute descriptive stats for an OHLCV series.
 *
 * @param {{ t:number|null, o:number|null, h:number|null, l:number|null, c:number|null, v:number|null }[]} rows
 * @returns {Object|null}
 */
function computeSeriesSummary(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const closes = [];
  let high = null;
  let low = null;
  let highTimestamp = null;
  let lowTimestamp = null;
  let volumeTotal = 0;
  let volumeCount = 0;
  let upCandles = 0;
  let downCandles = 0;
  let flatCandles = 0;
  let bodyPctSum = 0;
  let bodyPctCount = 0;
  let rangePctSum = 0;
  let rangePctCount = 0;

  for (const row of rows) {
    if (row?.h != null && Number.isFinite(row.h)) {
      if (high == null || row.h > high) {
        high = row.h;
        highTimestamp = row.t ?? null;
      }
    }
    if (row?.l != null && Number.isFinite(row.l)) {
      if (low == null || row.l < low) {
        low = row.l;
        lowTimestamp = row.t ?? null;
      }
    }
    if (row?.c != null && Number.isFinite(row.c)) {
      closes.push(row.c);
    }
    if (row?.v != null && Number.isFinite(row.v)) {
      volumeTotal += row.v;
      volumeCount += 1;
    }

    const o = row?.o;
    const c = row?.c;
    if (Number.isFinite(o) && Number.isFinite(c)) {
      if (c > o) upCandles += 1;
      else if (c < o) downCandles += 1;
      else flatCandles += 1;

      if (o !== 0) {
        bodyPctSum += Math.abs(c - o) / Math.abs(o) * 100;
        bodyPctCount += 1;
      }
      const range = row?.h != null && row?.l != null ? row.h - row.l : null;
      if (range != null && Number.isFinite(range) && o !== 0) {
        rangePctSum += range / Math.abs(o) * 100;
        rangePctCount += 1;
      }
    }
  }

  const count = rows.length;
  const first = rows[0] || null;
  const last = rows[count - 1] || null;
  const firstClose = first?.c ?? null;
  const lastClose = last?.c ?? null;
  const change = (firstClose != null && lastClose != null) ? lastClose - firstClose : null;
  const changePct = (change != null && firstClose) ? (change / firstClose) * 100 : null;
  const range = (high != null && low != null) ? high - low : null;
  const rangePct = (range != null && firstClose) ? (range / firstClose) * 100 : null;
  const meanClose = closes.length ? closes.reduce((sum, v) => sum + v, 0) / closes.length : null;

  let stdDevClose = null;
  if (closes.length > 1 && meanClose != null) {
    const variance = closes.reduce((sum, v) => sum + ((v - meanClose) ** 2), 0) / (closes.length - 1);
    stdDevClose = Number.isFinite(variance) ? Math.sqrt(variance) : null;
  }
  const volatilityPct = (stdDevClose != null && meanClose) ? (stdDevClose / meanClose) * 100 : null;

  return {
    candleCount: count,
    firstCandle: first,
    lastCandle: last,
    firstClose,
    lastClose,
    change,
    changePct,
    high,
    low,
    highTimestamp,
    lowTimestamp,
    range,
    rangePct,
    meanClose,
    stdDevClose,
    volatilityPct,
    volumeTotal: volumeCount ? volumeTotal : null,
    volumeAvg: volumeCount ? volumeTotal / volumeCount : null,
    volumeLast: last?.v ?? null,
    upCandles,
    downCandles,
    flatCandles,
    avgBodyPct: bodyPctCount ? bodyPctSum / bodyPctCount : null,
    avgRangePct: rangePctCount ? rangePctSum / rangePctCount : null,
  };
}

/**
 * Compute a summary for a time-bounded window.
 *
 * @param {{ t:number|null, o:number|null, h:number|null, l:number|null, c:number|null, v:number|null }[]} rows
 * @param {number} windowMs
 * @returns {Object|null}
 */
function computeWindowSummary(rows, windowMs) {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;

  const withTime = rows
    .map((row) => ({ row, tMs: normalizeTimestampMs(row?.t) }))
    .filter((entry) => entry.tMs != null);
  if (!withTime.length) return null;

  withTime.sort((a, b) => a.tMs - b.tMs);
  const lastMs = withTime[withTime.length - 1].tMs;
  const cutoff = lastMs - windowMs;
  const windowRows = withTime.filter((entry) => entry.tMs >= cutoff).map((entry) => entry.row);
  if (!windowRows.length) return null;
  return computeSeriesSummary(windowRows);
}

/**
 * Build a simple volume profile from candles.
 *
 * @param {{ t:number|null, o:number|null, h:number|null, l:number|null, c:number|null, v:number|null }[]} rows
 * @param {number} bucketCount
 * @returns {{ bucketCount: number, totalVolume: number|null, buckets: Array }|null}
 */
function computeVolumeProfile(rows, bucketCount) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const count = Math.max(1, Number(bucketCount || DEFAULT_VOLUME_PROFILE_BUCKETS));

  let minPrice = null;
  let maxPrice = null;
  for (const row of rows) {
    const low = row?.l;
    const high = row?.h;
    const close = row?.c;
    if (Number.isFinite(low)) {
      minPrice = minPrice == null ? low : Math.min(minPrice, low);
    }
    if (Number.isFinite(high)) {
      maxPrice = maxPrice == null ? high : Math.max(maxPrice, high);
    }
    if (minPrice == null && Number.isFinite(close)) minPrice = close;
    if (maxPrice == null && Number.isFinite(close)) maxPrice = close;
  }

  if (minPrice == null || maxPrice == null) return null;
  if (minPrice === maxPrice) {
    return {
      bucketCount: 1,
      totalVolume: null,
      buckets: [{
        priceMin: minPrice,
        priceMax: maxPrice,
        volume: null,
        volumePct: null,
      }],
    };
  }

  const range = maxPrice - minPrice;
  const buckets = Array.from({ length: count }, () => 0);

  let totalVolume = 0;
  for (const row of rows) {
    const v = Number.isFinite(row?.v) ? Number(row.v) : 0;
    const price = (Number.isFinite(row?.h) && Number.isFinite(row?.l) && Number.isFinite(row?.c))
      ? (row.h + row.l + row.c) / 3
      : (Number.isFinite(row?.c) ? row.c : null);
    if (price == null) continue;
    const idx = Math.min(count - 1, Math.max(0, Math.floor(((price - minPrice) / range) * count)));
    buckets[idx] += v;
    totalVolume += v;
  }

  const bucketSize = range / count;
  const detailed = buckets.map((volume, idx) => {
    const priceMin = minPrice + idx * bucketSize;
    const priceMax = priceMin + bucketSize;
    const volumePct = totalVolume > 0 ? (volume / totalVolume) * 100 : null;
    return {
      priceMin,
      priceMax,
      volume,
      volumePct,
    };
  });

  return {
    bucketCount: count,
    totalVolume: totalVolume || null,
    buckets: detailed,
  };
}

/**
 * Compute a confidence score for the regime classification.
 *
 * @param {Object|null} indicators
 * @returns {number|null}
 */
function computeRegimeConfidence(indicators) {
  if (!indicators) return null;
  let score = 0;
  let max = 0;

  const add = (present, weight) => {
    max += weight;
    if (present) score += weight;
  };

  add(indicators.lastClose != null, 1);
  add(indicators.emaFast != null && indicators.emaSlow != null, 2);
  add(indicators.macd && indicators.macd.hist != null, 1);
  add(indicators.rsi != null, 1);
  add(indicators.vwap != null, 1);
  add(indicators.atr != null, 1);

  if (!max) return null;
  return Number((score / max).toFixed(2));
}

/**
 * Build a standardized OHLCV context bundle with technical indicators.
 *
 * @param {Object} params
 * @param {Array} params.candles
 * @param {Array} [params.indicatorCandles]
 * @param {string} [params.granularity]
 * @param {number|string} [params.startTimestamp]
 * @param {number|string} [params.endTimestamp]
 * @param {Object} [params.indicatorConfig]
 * @param {Array} [params.summaryWindows]
 * @param {number} [params.volumeProfileBuckets]
 * @param {Object} [params.marketSnapshot]
 * @returns {Object}
 */
function buildOhlcvContext({
  candles,
  indicatorCandles,
  granularity,
  startTimestamp,
  endTimestamp,
  indicatorConfig,
  summaryWindows,
  volumeProfileBuckets,
  marketSnapshot,
} = {}) {
  const outputCandles = Array.isArray(candles) ? candles.map(normalizeCandle) : [];
  const indicatorSource = Array.isArray(indicatorCandles)
    ? indicatorCandles.map(normalizeCandle)
    : outputCandles;

  const indicatorRows = indicatorSource.filter((row) => (
    Number.isFinite(row?.h) && Number.isFinite(row?.l) && Number.isFinite(row?.c)
  ));
  const closes = indicatorRows.map((row) => row.c);
  const config = { ...DEFAULT_INDICATORS, ...(indicatorConfig || {}) };
  const summary = computeSeriesSummary(indicatorRows);
  const windowSpecs = normalizeSummaryWindows(summaryWindows);
  const summaryWindowsOut = {};
  windowSpecs.forEach((spec) => {
    const windowSummary = computeWindowSummary(indicatorRows, spec.windowMs);
    if (windowSummary) {
      summaryWindowsOut[spec.label] = windowSummary;
    }
  });
  const volumeProfile = computeVolumeProfile(indicatorRows, volumeProfileBuckets);

  let indicators = null;
  const warnings = [];

  if (!outputCandles.length) warnings.push('ohlcv_empty');
  if (!indicatorRows.length) warnings.push('ohlcv_indicator_empty');

  if (closes.length) {
    const emaFast = computeEmaSeries(closes, config.emaFast);
    const emaSlow = computeEmaSeries(closes, config.emaSlow);
    const macd = computeMacd(closes, config.emaFast, config.emaSlow, config.macdSignal);
    const vwapRes = computeVwap(indicatorRows, config.vwapPeriods);

    indicators = {
      rsi: computeRsi(closes, config.rsiPeriod),
      atr: computeAtr(indicatorRows, config.atrPeriod),
      slopePctPerCandle: computeSlopePct(closes, config.slopePeriods),
      emaFast,
      emaSlow,
      macd,
      vwap: vwapRes.vwap,
      vwapVolume: vwapRes.volume,
      lastClose: closes.length ? closes[closes.length - 1] : null,
    };

    if (vwapRes.volume === 0) warnings.push('ohlcv_zero_volume');
  }

  const derived = {};
  if (indicators && indicators.atr != null && indicators.lastClose != null) {
    const atr = Number(indicators.atr);
    const lastClose = Number(indicators.lastClose);
    if (Number.isFinite(atr) && Number.isFinite(lastClose) && lastClose > 0) {
      derived.atrPct = (atr / lastClose) * 100;
    }
  }

  const hasSignal =
    indicators
    && (indicators.emaFast != null || indicators.emaSlow != null || indicators.rsi != null || indicators.macd?.hist != null || indicators.vwap != null);
  const regimeBase = hasSignal
    ? computeMarketRegime({ indicators, chart: { candles: indicatorRows } })
    : { status: 'unknown', reasons: ['missing_indicators'] };
  const regime = {
    ...regimeBase,
    confidence: computeRegimeConfidence(indicators),
  };

  return {
    granularity: granularity || null,
    startTimestamp: startTimestamp ?? null,
    endTimestamp: endTimestamp ?? null,
    points: outputCandles.length,
    indicatorPoints: indicatorRows.length,
    candles: outputCandles,
    summary,
    summaryWindows: summaryWindowsOut,
    volumeProfile,
    marketSnapshot: marketSnapshot || null,
    indicators,
    derived: Object.keys(derived).length ? derived : null,
    regime,
    indicatorConfig: config,
    warnings,
  };
}

module.exports = {
  buildOhlcvContext,
};
