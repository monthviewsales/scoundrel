'use strict';

/**
 * Bind helper fetching a single token price.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { mint?: string, tokenAddress?: string, includePriceChanges?: boolean }) => Promise<any>}
 */
function createGetTokenPrice({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenPrice: missing dependencies');

  return async function getTokenPrice(options = {}) {
    const { mint, tokenAddress, includePriceChanges = false } = options;
    const target = typeof mint === 'string' && mint.trim() !== '' ? mint.trim() : tokenAddress?.trim();
    if (!target) throw new Error('getTokenPrice: mint or tokenAddress is required');

    return call('getTokenPrice', () => client.getPrice(target, includePriceChanges === true));
  };
}

module.exports = { createGetTokenPrice };
