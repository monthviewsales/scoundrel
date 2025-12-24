'use strict';

const { STABLE_MINT_LIST, isStableMint } = require('../../lib/solana/stableMints');

describe('stableMints', () => {
  test('recognizes known stable mints', () => {
    for (const mint of STABLE_MINT_LIST) {
      expect(isStableMint(mint)).toBe(true);
    }
  });

  test('returns false for non-stable mints', () => {
    expect(isStableMint('So11111111111111111111111111111111111111112')).toBe(false);
    expect(isStableMint('NotARealMint1111111111111111111111111111111')).toBe(false);
  });
});
