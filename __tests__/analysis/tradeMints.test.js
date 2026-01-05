'use strict';

const {
  isBase58Mint,
  isSolToStableSwap,
} = require('../../lib/analysis/tradeMints');

describe('tradeMints helpers', () => {
  test('isBase58Mint validates base58 mint strings', () => {
    expect(isBase58Mint('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isBase58Mint('11111111111111111111111111111111')).toBe(true);
    expect(isBase58Mint('not-a-mint')).toBe(false);
    expect(isBase58Mint('')).toBe(false);
  });

  test('isSolToStableSwap detects SOL to stable profit-taking swaps', () => {
    const trade = {
      from: { address: 'So11111111111111111111111111111111111111112' },
      to: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    };

    expect(isSolToStableSwap(trade)).toBe(true);
    expect(isSolToStableSwap({ from: { address: 'AABB' }, to: trade.to })).toBe(false);
    expect(isSolToStableSwap({})).toBe(false);
  });
});
