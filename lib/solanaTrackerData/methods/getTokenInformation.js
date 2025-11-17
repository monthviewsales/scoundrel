'use strict';

/**
 * Bind getTokenInformation helper.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddress: string) => Promise<any>}
 */
function createGetTokenInformation({ client, call }) {
  if (!client || !call) {
    throw new Error('createGetTokenInformation: missing client or call helper');
  }

  return async function getTokenInformation(tokenAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getTokenInformation: tokenAddress is required');
    }
    const mint = tokenAddress.trim();

    return call('getTokenInformation', () => client.getTokenInfo(mint));
  };
}

module.exports = { createGetTokenInformation };
