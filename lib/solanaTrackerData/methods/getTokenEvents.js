'use strict';

/**
 * Bind helper returning decoded token events payload.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddress: string) => Promise<any>}
 */
function createGetTokenEvents({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenEvents: missing dependencies');

  return async function getTokenEvents(tokenAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getTokenEvents: tokenAddress is required');
    }
    const mint = tokenAddress.trim();
    return call('getTokenEvents', () => client.getEvents(mint));
  };
}

module.exports = { createGetTokenEvents };
