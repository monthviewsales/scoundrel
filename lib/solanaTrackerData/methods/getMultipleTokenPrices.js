'use strict';

/**
 * Bind helper fetching price data for multiple tokens.
 *
 * Supports both call styles:
 *   - getMultipleTokenPrices([mint1, mint2, ...])
 *   - getMultipleTokenPrices({ mints: [mint1, mint2, ...], includePriceChanges: true })
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(mintsOrOptions: string[] | { mints: string[], includePriceChanges?: boolean }) => Promise<any>}
 */
function createGetMultipleTokenPrices({ client, call }) {
  if (!client || !call) throw new Error('createGetMultipleTokenPrices: missing dependencies');

  return async function getMultipleTokenPrices(mintsOrOptions = {}) {
    // Allow calling with array directly: getMultipleTokenPrices([mint1, mint2])
    // or with options object: getMultipleTokenPrices({ mints: [...], includePriceChanges })
    const includePriceChanges =
      !!(mintsOrOptions && typeof mintsOrOptions === 'object' && !Array.isArray(mintsOrOptions)
        ? mintsOrOptions.includePriceChanges
        : false);

    const mints = Array.isArray(mintsOrOptions)
      ? mintsOrOptions
      : (mintsOrOptions && mintsOrOptions.mints) || [];

    if (!Array.isArray(mints) || mints.length === 0) {
      throw new Error('getMultipleTokenPrices: mints must be a non-empty array');
    }

    const cleaned = mints.map((addr) => {
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
