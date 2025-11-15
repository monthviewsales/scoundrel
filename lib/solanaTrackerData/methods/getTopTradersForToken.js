'use strict';

/**
 * Bind helper returning token-specific top traders list.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddress: string) => Promise<any>}
 */
function createGetTopTradersForToken({ client, call }) {
  if (!client || !call) throw new Error('createGetTopTradersForToken: missing dependencies');

  return async function getTopTradersForToken(tokenAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getTopTradersForToken: tokenAddress is required');
    }
    const mint = tokenAddress.trim();
    return call('getTopTradersForToken', () => client.getTokenTopTraders(mint));
  };
}

module.exports = { createGetTopTradersForToken };
