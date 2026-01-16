'use strict';

const {
  mean,
  median,
  percentile,
  computeRealizedStats,
  detectEntryStyle,
  buildFromMintMap,
  computeOutcomesFromMintMap,
} = require('../../lib/analysis/techniqueOutcomes');

describe('techniqueOutcomes helpers', () => {
  test('basic stats helpers compute expected values', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 3, 2, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  test('computeRealizedStats pairs buys/sells', () => {
    const buys = [
      { amount: 1, priceUsd: 1, time: 0 },
      { amount: 1, priceUsd: 1.5, time: 60_000 },
    ];
    const sells = [
      { amount: 2, priceUsd: 2, time: 120_000 },
    ];

    const stats = computeRealizedStats(buys, sells);
    expect(stats.nClosed).toBe(1);
    expect(stats.medianGainPct).toBeGreaterThan(0);
    expect(stats.medianHoldMins).toBe(2);
  });

  test('detectEntryStyle returns single for one buy', () => {
    const result = detectEntryStyle([{ time: 0 }]);
    expect(result.signal).toBe('single');
  });

  test('buildFromMintMap emits overall stats', () => {
    const mintMap = {
      MintA: [
        { type: 'buy', amount: 1, priceUsd: 1, time: 0, program: 'jup' },
        { type: 'sell', amount: 1, priceUsd: 2, time: 60_000, program: 'jup' },
      ],
    };

    const result = buildFromMintMap(mintMap, 5);
    expect(result.overall.nCoins).toBe(1);
    expect(result.coins).toHaveLength(1);
  });

  test('computeOutcomesFromMintMap aggregates per-mint outcomes', () => {
    const mintMap = {
      MintA: [
        { type: 'buy', amount: 1, priceUsd: 1, time: 0 },
        { type: 'sell', amount: 1, priceUsd: 2, time: 60_000 },
      ],
    };

    const result = computeOutcomesFromMintMap(mintMap, null);
    expect(result.winRate).toBe(1);
    expect(result.medianHoldMins).toBe(1);
  });
});
