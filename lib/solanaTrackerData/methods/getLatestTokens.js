'use strict';

/**
 * Bind helper for fetching most recent tokens.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(page?: number) => Promise<any>}
 */
function createGetLatestTokens({ client, call }) {
  if (!client || !call) throw new Error('createGetLatestTokens: missing dependencies');

  return async function getLatestTokens(page = 1) {
    if (page != null && (!Number.isInteger(page) || page <= 0)) {
      throw new Error('getLatestTokens: page must be a positive integer');
    }

    return call('getLatestTokens', () => client.getLatestTokens(page ?? 1));
  };
}

module.exports = { createGetLatestTokens };
