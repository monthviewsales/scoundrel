'use strict';

/**
 * Create helper for getTokenByPoolAddress.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(poolAddress: string) => Promise<any>}
 */
function createGetTokenByPoolAddress({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenByPoolAddress: missing dependencies');

  return async function getTokenByPoolAddress(poolAddress) {
    if (typeof poolAddress !== 'string' || poolAddress.trim() === '') {
      throw new Error('getTokenByPoolAddress: poolAddress is required');
    }
    const address = poolAddress.trim();
    return call('getTokenByPoolAddress', () => client.getTokenByPool(address));
  };
}

module.exports = { createGetTokenByPoolAddress };
