'use strict';

/**
 * Bind helper fetching price data for multiple tokens.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { mints: string[], includePriceChanges?: boolean }) => Promise<any>}
 */
function createGetMultipleTokenPrices({ client, call }) {
  if (!client || !call) throw new Error('createGetMultipleTokenPrices: missing dependencies');

  return async function getMultipleTokenPrices(options = {}) {
    const { mints, includePriceChanges = false } = options;
    if (!Array.isArray(mints) || mints.length === 0) {
      throw new Error('getMultipleTokenPrices: mints must be a non-empty array');
    }
    const cleaned = mints.map(addr => {
      if (typeof addr !== 'string' || addr.trim() === '') {
        throw new Error('getMultipleTokenPrices: mints must contain non-empty strings');
      }
      return addr.trim();
    });

    return call(
      'getMultipleTokenPrices',
      () => client.getMultiplePrices(cleaned, includePriceChanges === true),
    );
  };
}

module.exports = { createGetMultipleTokenPrices };
