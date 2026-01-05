'use strict';

/**
 * Normalize a raw chart array into sorted points with { t, pnl } where:
 *  - t: epoch ms
 *  - pnl: pnl percentage (float)
 * This is defensive against slightly different shapes from the API.
 * @param {any[]} rawChart
 * @returns {{ t: number, pnl: number }[]}
 */
function normalizeChartPoints(rawChart) {
  if (!Array.isArray(rawChart)) return [];
  const points = rawChart
    .map((pt) => {
      const tCandidate =
        pt == null ? null :
          (pt.t ?? pt.time ?? pt.timestamp ?? pt.ts ?? pt.date);
      const pnlCandidate =
        pt == null ? null :
          (pt.pnlPercentage ?? pt.pnlPct ?? pt.pnl_percent ?? pt.pnl);
      const t = Number(tCandidate);
      const pnl = Number(pnlCandidate);
      if (!Number.isFinite(t) || !Number.isFinite(pnl)) return null;
      return { t, pnl };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  return points;
}

/**
 * Build simple wallet-level stats from the equity curve.
 * - timeframe start/end
 * - start/end pnl%
 * - largest single-step run-up and drawdown in pnl%
 * - a coarse recent trend label (up/down/flat) based on last few points
 * @param {any[]} rawChart
 * @returns {object|null}
 */
function buildWalletStatsFromChart(rawChart) {
  const points = normalizeChartPoints(rawChart);
  if (!points.length) return null;

  const first = points[0];
  const last = points[points.length - 1];

  let maxRunDeltaPct = null;
  let maxDrawdownDeltaPct = null;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const delta = cur.pnl - prev.pnl;
    if (maxRunDeltaPct == null || delta > maxRunDeltaPct) maxRunDeltaPct = delta;
    if (maxDrawdownDeltaPct == null || delta < maxDrawdownDeltaPct) maxDrawdownDeltaPct = delta;
  }

  // Recent trend based on last few deltas
  const windowSize = Math.min(5, points.length - 1);
  let recentTrend = 'flat';
  if (windowSize > 0) {
    const deltas = [];
    for (let i = points.length - windowSize; i < points.length; i += 1) {
      const prev = points[i - 1];
      const cur = points[i];
      deltas.push(cur.pnl - prev.pnl);
    }
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (avgDelta > 5) recentTrend = 'up';
    else if (avgDelta < -5) recentTrend = 'down';
    else recentTrend = 'flat';
  }

  return {
    timeframeStart: first.t,
    timeframeEnd: last.t,
    startPnlPct: first.pnl,
    endPnlPct: last.pnl,
    maxRunDeltaPct,
    maxDrawdownDeltaPct,
    recentTrend,
  };
}

/**
 * Derive a small list of regime events (major runs/nukes) from the chart.
 * Events are based on step-wise changes in pnl% between consecutive points.
 * @param {any[]} rawChart
 * @returns {Array<{ timestamp: number, deltaPnlPct: number, fromPnlPct: number, toPnlPct: number, label: string }>}
 */
function buildRegimeEventsFromChart(rawChart) {
  const points = normalizeChartPoints(rawChart);
  if (points.length < 2) return [];

  const events = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const delta = cur.pnl - prev.pnl;

    let label = null;
    if (delta >= 40) {
      label = 'major_run';
    } else if (delta <= -70) {
      label = 'catastrophic_nuke';
    } else if (delta <= -40) {
      label = 'major_nuke';
    }

    if (label) {
      events.push({
        timestamp: cur.t,
        deltaPnlPct: delta,
        fromPnlPct: prev.pnl,
        toPnlPct: cur.pnl,
        label,
      });
    }
  }

  // Keep the largest-magnitude events (up to 5)
  events.sort((a, b) => Math.abs(b.deltaPnlPct) - Math.abs(a.deltaPnlPct));
  return events.slice(0, 5);
}

module.exports = {
  normalizeChartPoints,
  buildWalletStatsFromChart,
  buildRegimeEventsFromChart,
};
