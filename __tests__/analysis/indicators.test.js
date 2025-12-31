'use strict';

const { computeMarketRegime } = require('../../lib/analysis/indicators');

describe('analysis indicators', () => {
  test('computeMarketRegime derives a trend_up regime with momentum cues', () => {
    const evaluation = {
      chart: { candles: [{ t: 1 }, { t: 2 }] },
      indicators: {
        lastClose: 11,
        emaFast: 12,
        emaSlow: 10,
        rsi: 75,
        atr: 0.5,
        vwap: 10.5,
        macd: { hist: 0.3 },
      },
    };

    const regime = computeMarketRegime(evaluation);
    expect(regime.status).toBe('trend_up');
    expect(regime.reasons).toEqual(expect.arrayContaining(['trend:up', 'macd:bullish', 'rsi:overbought']));
  });

  test('computeMarketRegime returns unknown when indicators are missing', () => {
    const regime = computeMarketRegime({ chart: null, indicators: null });
    expect(regime.status).toBe('unknown');
    expect(regime.reasons).toContain('missing_indicators_or_chart');
  });
});
