'use strict';

/**
 * @typedef {Object} ChartPoint
 * @property {string} date - ISO date string or YYYY-MM-DD. Time component allowed.
 * @property {number} [value] - Portfolio/equity value at this timestamp (preferred).
 * @property {number} [pnlPercentage] - Cumulative PnL percentage at this timestamp (optional fallback).
 */

/**
 * Normalize to a numeric value series we can compute with.
 * Prefers `value`. If absent, synthesizes from `pnlPercentage` using a 100 baseline.
 * Points with neither are dropped.
 * @param {ChartPoint[]} raw
 * @returns {{date: Date, value: number}[]} sorted ascending by date
 */
function normalizeValueSeries(raw) {
  if (!Array.isArray(raw)) return [];

  // Parse and keep only usable points
  const rows = raw
    .map(p => {
      const d = new Date(p.date);
      const hasValue = Number.isFinite(p.value);
      const hasPnL = Number.isFinite(p.pnlPercentage);
      return { d, v: hasValue ? Number(p.value) : null, pnlPct: hasPnL ? Number(p.pnlPercentage) : null };
    })
    .filter(r => r.d.toString() !== 'Invalid Date' && (Number.isFinite(r.v) || Number.isFinite(r.pnlPct)))
    .sort((a, b) => a.d - b.d);

  if (rows.length === 0) return [];

  // If at least one real value exists, prefer the real value path.
  const hasAnyRealValue = rows.some(r => Number.isFinite(r.v));

  if (hasAnyRealValue) {
    // Forward-fill only real values; drop rows without a value
    return rows
      .filter(r => Number.isFinite(r.v))
      .map(r => ({ date: r.d, value: r.v }));
  }

  // Fallback: synthesize value series from cumulative pnlPercentage.
  // Assume the first point corresponds to 100 baseline equity.
  let baseline = 100;
  return rows.map(r => {
    // If pnlPercentage is cumulative vs original baseline, value = 100 * (1 + pnl%/100)
    const val = baseline * (1 + r.pnlPct / 100);
    return { date: r.d, value: val };
  });
}

/**
 * Get YYYY-MM from a Date.
 * @param {Date} d
 * @returns {string}
 */
function monthKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Round to fixed decimals, return Number (not string).
 * @param {number} n
 * @param {number} [dec=2]
 * @returns {number}
 */
function round(n, dec = 2) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, dec);
  return Math.round(n * f) / f;
}

/**
 * Summarize monthly PnL (%) based on start/end values per calendar month.
 * @param {ChartPoint[]} chartPoints
 * @returns {{ month: string, pnl_pct: number, start_value: number, end_value: number }[]}
 */
function summarizeMonthlyPnL(chartPoints) {
  const series = normalizeValueSeries(chartPoints);
  if (series.length === 0) return [];

  // Bucket by month -> track first and last value
  const buckets = new Map();
  for (const p of series) {
    const key = monthKey(p.date);
    if (!buckets.has(key)) {
      buckets.set(key, { start: p.value, end: p.value });
    } else {
      const b = buckets.get(key);
      b.end = p.value;
    }
  }

  // Emit sorted by month asc
  const months = Array.from(buckets.keys()).sort();
  return months.map(key => {
    const b = buckets.get(key);
    const start = b.start;
    const end = b.end;
    const pnlPct = Number.isFinite(start) && start !== 0 ? ((end - start) / start) * 100 : 0;
    return {
      month: key,
      pnl_pct: round(pnlPct, 2),
      start_value: round(start, 2),
      end_value: round(end, 2),
    };
  });
}

/**
 * Compute wallet-level curve stats from the value series.
 * - max_drawdown_pct: classic peak-to-trough (percent)
 * - volatility_30d_pct: stdev of daily % returns over last ~30 calendar days, annualized
 * - pnl_max_pct / pnl_min_pct: pct change vs first value across entire series
 * - streaks: consecutive up/down days based on sign of daily return
 * @param {ChartPoint[]} chartPoints
 * @returns {{
 *   pnl_max_pct: number|null,
 *   pnl_min_pct: number|null,
 *   max_drawdown_pct: number|null,
 *   volatility_30d_pct: number|null,
 *   recovery_days_from_last_dd: number|null,
 *   streaks: { max_up_days: number, max_down_days: number }
 * }}
 */
function computeWalletCurveStats(chartPoints) {
  const series = normalizeValueSeries(chartPoints);
  if (series.length === 0) {
    return {
      pnl_max_pct: null,
      pnl_min_pct: null,
      max_drawdown_pct: null,
      volatility_30d_pct: null,
      recovery_days_from_last_dd: null,
      streaks: { max_up_days: 0, max_down_days: 0 },
    };
  }

  // Collapse to one point per day (last point of the day)
  const perDay = new Map();
  for (const p of series) {
    const day = p.date.toISOString().slice(0, 10); // YYYY-MM-DD
    perDay.set(day, p.value); // last value of day wins
  }
  const days = Array.from(perDay.keys()).sort();
  const values = days.map(d => perDay.get(d));

  const first = values[0];
  const last = values[values.length - 1];

  const pnlMax = first !== 0 ? ((Math.max(...values) - first) / first) * 100 : null;
  const pnlMin = first !== 0 ? ((Math.min(...values) - first) / first) * 100 : null;

  // Max drawdown & recovery
  let peak = values[0];
  let maxDD = 0;
  let ddTroughIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
    }
    const dd = peak !== 0 ? (values[i] - peak) / peak : 0; // negative
    if (dd < maxDD) {
      maxDD = dd;
      // track trough index
      ddTroughIdx = i;
    }
  }
  // Find days since trough to recovery (value >= prior peak) if any
  let recoveryDays = null;
  if (maxDD < 0) {
    // find the peak that preceded the trough
    peak = values[0];
    let runningPeakIdx = 0;
    for (let i = 1; i <= ddTroughIdx; i++) {
      if (values[i] > peak) {
        peak = values[i];
        runningPeakIdx = i;
      }
    }
    // search forward for recovery
    for (let j = ddTroughIdx + 1; j < values.length; j++) {
      if (values[j] >= peak) {
        recoveryDays = j - ddTroughIdx;
        break;
      }
    }
  }

  // Daily returns for last ~30 days window
  const returns = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev && prev !== 0 && Number.isFinite(curr)) {
      returns.push((curr - prev) / prev);
    }
  }
  const last30 = returns.slice(-30);
  const mean =
    last30.length > 0 ? last30.reduce((a, b) => a + b, 0) / last30.length : 0;
  const variance =
    last30.length > 1
      ? last30.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / (last30.length - 1)
      : 0;
  const stdev = Math.sqrt(variance);
  const volAnnualPct = round(stdev * Math.sqrt(365) * 100, 2);

  // Streaks
  let up = 0, down = 0, maxUp = 0, maxDown = 0;
  for (let i = 1; i < values.length; i++) {
    const r = values[i - 1] !== 0 ? (values[i] - values[i - 1]) / values[i - 1] : 0;
    if (r > 0) {
      up += 1; down = 0; if (up > maxUp) maxUp = up;
    } else if (r < 0) {
      down += 1; up = 0; if (down > maxDown) maxDown = down;
    } else {
      // flat day resets both
      up = 0; down = 0;
    }
  }

  return {
    pnl_max_pct: Number.isFinite(pnlMax) ? round(pnlMax, 2) : null,
    pnl_min_pct: Number.isFinite(pnlMin) ? round(pnlMin, 2) : null,
    max_drawdown_pct: round(maxDD * 100, 2),
    volatility_30d_pct: Number.isFinite(volAnnualPct) ? volAnnualPct : null,
    recovery_days_from_last_dd: recoveryDays,
    streaks: { max_up_days: maxUp, max_down_days: maxDown },
  };
}

/**
 * Convenience wrapper for the orchestrator:
 * Produces both the monthly PnL array and the wallet-curve stats block
 * from a chart array (no I/O).
 * @param {ChartPoint[]} chartPoints
 * @returns {{ wallet_performance: Array<{month:string,pnl_pct:number,start_value:number,end_value:number}>, wallet_curve: ReturnType<typeof computeWalletCurveStats> }}
 */
function summarizeForSidecar(chartPoints) {
  return {
    wallet_performance: summarizeMonthlyPnL(chartPoints),
    wallet_curve: computeWalletCurveStats(chartPoints),
  };
}

module.exports = {
  summarizeMonthlyPnL,
  computeWalletCurveStats,
  summarizeForSidecar,
};
