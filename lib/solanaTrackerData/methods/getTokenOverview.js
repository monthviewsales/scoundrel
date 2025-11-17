'use strict';

/**
 * Bind helper for token overview feed.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options?: { limit?: number }) => Promise<any>}
 */
function createGetTokenOverview({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenOverview: missing dependencies');

  return async function getTokenOverview(options = {}) {
    const { limit } = options;
    if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error('getTokenOverview: limit must be a positive integer');
    }

    return call('getTokenOverview', () => client.getTokenOverview(limit));
  };
}

module.exports = { createGetTokenOverview };
