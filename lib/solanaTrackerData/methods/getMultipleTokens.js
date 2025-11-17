'use strict';

/**
 * Bind helper fetching multiple token payloads.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(tokenAddresses: string[]) => Promise<any>}
 */
function createGetMultipleTokens({ client, call }) {
  if (!client || !call) throw new Error('createGetMultipleTokens: missing dependencies');

  return async function getMultipleTokens(tokenAddresses) {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
      throw new Error('getMultipleTokens: tokenAddresses must be a non-empty array');
    }

    const cleaned = tokenAddresses.map(addr => {
      if (typeof addr !== 'string' || addr.trim() === '') {
        throw new Error('getMultipleTokens: tokenAddresses must contain non-empty strings');
      }
      return addr.trim();
    });

    return call('getMultipleTokens', () => client.getMultipleTokens(cleaned));
  };
}

module.exports = { createGetMultipleTokens };
