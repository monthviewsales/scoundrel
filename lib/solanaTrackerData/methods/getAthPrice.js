'use strict';

/**
 * Bind helper fetching all-time-high price for a token.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddress: string) => Promise<any>}
 */
function createGetAthPrice({ client, call }) {
  if (!client || !call) throw new Error('createGetAthPrice: missing dependencies');

  return async function getAthPrice(tokenAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getAthPrice: tokenAddress is required');
    }

    const mint = tokenAddress.trim();

    return call('getAthPrice', () => client.getAthPrice(mint));
  };
}

module.exports = { createGetAthPrice };
