'use strict';

/**
 * Bind helper fetching price range for a token within a window.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddress: string, timeFrom: number, timeTo: number) => Promise<any>}
 */
function createGetPriceRange({ client, call }) {
  if (!client || !call) throw new Error('createGetPriceRange: missing dependencies');

  return async function getPriceRange(tokenAddress, timeFrom, timeTo) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getPriceRange: tokenAddress is required');
    }
    if (!Number.isFinite(timeFrom) || !Number.isFinite(timeTo)) {
      throw new Error('getPriceRange: timeFrom and timeTo are required numbers');
    }

    const mint = tokenAddress.trim();

    return call('getPriceRange', () => client.getPriceRange(mint, timeFrom, timeTo));
  };
}

module.exports = { createGetPriceRange };
