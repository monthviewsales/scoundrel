'use strict';

const { _internal } = require('../../db/src/services/evaluationService');

describe('evaluationService.computeDerived', () => {
  test('uses expectedNotionalUsd when no position size exists', () => {
    const derived = _internal.computeDerived({
      position: { expectedNotionalUsd: 1000 },
      coin: { priceUsd: 1 },
      pool: { liquidity_usd: 20000 },
      pnl: null,
    });

    expect(derived.positionValueUsd).toBe(1000);
    expect(derived.liquidityToPositionRatio).toBeCloseTo(20);
  });

  test('uses expectedNotionalSol with SOL quote to compute ratio', () => {
    const derived = _internal.computeDerived({
      position: { expectedNotionalSol: 0.5 },
      coin: { priceSol: 0.01, priceUsd: 2 },
      pool: { liquidity_usd: 20000, price_quote: 0.01, price_usd: 2, quoteToken: 'SOL' },
      pnl: null,
    });

    expect(derived.positionValueUsd).toBeCloseTo(100);
    expect(derived.liquidityToPositionRatio).toBeCloseTo(200);
  });
});
