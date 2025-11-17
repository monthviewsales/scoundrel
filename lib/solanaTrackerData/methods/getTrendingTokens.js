'use strict';

const VALID_TIMEFRAMES = ['5m', '15m', '30m', '1h', '2h', '3h', '4h', '5h', '6h', '12h', '24h'];

/**
 * Bind helper fetching trending tokens.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options?: { timeframe?: string }) => Promise<any>}
 */
function createGetTrendingTokens({ client, call }) {
  if (!client || !call) throw new Error('createGetTrendingTokens: missing dependencies');

  return async function getTrendingTokens(options = {}) {
    const { timeframe } = options;
    if (timeframe && !VALID_TIMEFRAMES.includes(timeframe)) {
      throw new Error(`getTrendingTokens: timeframe must be one of ${VALID_TIMEFRAMES.join(', ')}`);
    }

    return call('getTrendingTokens', () => client.getTrendingTokens(timeframe));
  };
}

module.exports = { createGetTrendingTokens };
