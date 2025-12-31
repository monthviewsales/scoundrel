'use strict';

const { buildHudPayload } = require('../../../../lib/warchest/workers/sellOps/hudPublisher');

describe('sellOps hudPublisher', () => {
  test('builds HUD payload with indicators and metrics', () => {
    const snapshot = {
      ts: 123,
      walletAlias: 'alpha',
      tradeUuid: 'trade-1',
      mint: 'mint-1',
      decision: 'hold',
      reasons: ['reason'],
      regime: { status: 'trend_up', reasons: ['r'] },
      evaluation: {
        symbol: 'ABC',
        strategy: { name: 'Flash' },
        qualify: { worstSeverity: 'none', failedCount: 0 },
        recommendation: 'hold',
        warnings: [],
        chart: { type: '1m', points: 10, poolAddress: 'pool', timeFrom: 1, timeTo: 2 },
        indicators: {
          rsi: 55,
          atr: 0.2,
          emaFast: 1.1,
          emaSlow: 1.0,
          macd: { hist: 0.01 },
          vwap: 1.05,
          vwapVolume: 100,
        },
        coin: { priceUsd: 1.2 },
        pool: { liquidity_usd: 250 },
        pnl: { unrealized_usd: 5, total_usd: 9 },
        derived: { roiUnrealizedPct: 10 },
      },
    };

    const payload = buildHudPayload(snapshot);
    expect(payload.walletAlias).toBe('alpha');
    expect(payload.symbol).toBe('ABC');
    expect(payload.chart.type).toBe('1m');
    expect(payload.indicators.macdHist).toBeCloseTo(0.01);
    expect(payload.metrics.priceUsd).toBe(1.2);
  });
});
