'use strict';

/**
 * Bind helper returning the top token holders.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddress: string) => Promise<any>}
 */
function createGetTokenHoldersTop100({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenHoldersTop100: missing dependencies');

  return async function getTokenHoldersTop100(tokenAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getTokenHoldersTop100: tokenAddress is required');
    }
    const mint = tokenAddress.trim();
    return call('getTokenHoldersTop100', () => client.getTopHolders(mint));
  };
}

module.exports = { createGetTokenHoldersTop100 };
