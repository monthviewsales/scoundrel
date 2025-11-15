'use strict';

const VALID_TIMEFRAMES = ['5m', '15m', '30m', '1h', '6h', '12h', '24h'];

/**
 * Bind helper for /tokens/volume endpoint.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options?: { timeframe?: string }) => Promise<any>}
 */
function createGetTokensByVolumeWithTimeframe({ client, call }) {
  if (!client || !call) throw new Error('createGetTokensByVolumeWithTimeframe: missing dependencies');

  return async function getTokensByVolumeWithTimeframe(options = {}) {
    const { timeframe } = options;
    if (timeframe && !VALID_TIMEFRAMES.includes(timeframe)) {
      throw new Error(`getTokensByVolumeWithTimeframe: timeframe must be one of ${VALID_TIMEFRAMES.join(', ')}`);
    }

    return call('getTokensByVolumeWithTimeframe', () => client.getTokensByVolume(timeframe));
  };
}

module.exports = { createGetTokensByVolumeWithTimeframe };
