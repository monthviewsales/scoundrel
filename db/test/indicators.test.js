'use strict';

const {
  computeRsi,
  computeMacd,
  computeVwap,
} = require('../src/services/indicators');

describe('db indicators', () => {
  test('computeRsi returns 100 on uninterrupted gains', () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(computeRsi(closes, 14)).toBe(100);
  });

  test('computeMacd returns a populated object when enough data exists', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 1 + i * 0.5);
    const macd = computeMacd(closes, 12, 26, 9);
    expect(macd).toBeTruthy();
    expect(macd.hist).not.toBeNull();
  });

  test('computeVwap returns zero volume when candles have no volume', () => {
    const candles = [
      { h: 2, l: 1, c: 1.5, v: 0 },
      { h: 2.1, l: 1.1, c: 1.6, v: 0 },
    ];
    const res = computeVwap(candles, null);
    expect(res.volume).toBe(0);
    expect(res.vwap).toBeNull();
  });
});
