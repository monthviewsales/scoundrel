'use strict';

const {
  normalizeChartPoints,
  buildWalletStatsFromChart,
  buildRegimeEventsFromChart,
} = require('../../lib/analysis/walletChart');

describe('walletChart helpers', () => {
  test('normalizeChartPoints filters and sorts chart points', () => {
    const raw = [
      { t: 3, pnlPercentage: 10 },
      { timestamp: '1', pnl: '-5' },
      { time: 2, pnlPct: 0 },
      { t: 'bad', pnl: 2 },
    ];

    expect(normalizeChartPoints(raw)).toEqual([
      { t: 1, pnl: -5 },
      { t: 2, pnl: 0 },
      { t: 3, pnl: 10 },
    ]);
  });

  test('buildWalletStatsFromChart returns summary stats', () => {
    const raw = [
      { t: 1, pnlPercentage: -10 },
      { t: 2, pnlPercentage: 0 },
      { t: 3, pnlPercentage: 30 },
      { t: 4, pnlPercentage: 10 },
    ];

    expect(buildWalletStatsFromChart(raw)).toEqual({
      timeframeStart: 1,
      timeframeEnd: 4,
      startPnlPct: -10,
      endPnlPct: 10,
      maxRunDeltaPct: 30,
      maxDrawdownDeltaPct: -20,
      recentTrend: 'up',
    });
  });

  test('buildRegimeEventsFromChart extracts major runs and nukes', () => {
    const raw = [
      { t: 1, pnlPercentage: 0 },
      { t: 2, pnlPercentage: 45 },
      { t: 3, pnlPercentage: -5 },
      { t: 4, pnlPercentage: -85 },
    ];

    const events = buildRegimeEventsFromChart(raw);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ label: 'catastrophic_nuke', deltaPnlPct: -80 });
    expect(events[1]).toMatchObject({ label: 'major_nuke', deltaPnlPct: -50 });
    expect(events[2]).toMatchObject({ label: 'major_run', deltaPnlPct: 45 });
  });
});
