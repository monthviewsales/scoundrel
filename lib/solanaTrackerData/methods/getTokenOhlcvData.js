'use strict';

/**
 * Bind helper for OHLCV chart data per token.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { tokenAddress?: string, mint?: string, type?: string, timeFrom?: number, timeTo?: number, marketCap?: boolean, removeOutliers?: boolean, dynamicPools?: boolean, timezone?: string, fastCache?: boolean }) => Promise<any>}
 */
function createGetTokenOhlcvData({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenOhlcvData: missing dependencies');

  return async function getTokenOhlcvData(options = {}) {
    const {
      tokenAddress,
      mint,
      type,
      timeFrom,
      timeTo,
      marketCap,
      removeOutliers,
      dynamicPools,
      timezone,
      fastCache,
    } = options;

    const target = typeof mint === 'string' && mint.trim() !== '' ? mint.trim() : tokenAddress?.trim();
    if (!target) throw new Error('getTokenOhlcvData: tokenAddress (mint) is required');

    return call('getTokenOhlcvData', () => client.getChartData({
      tokenAddress: target,
      type,
      timeFrom,
      timeTo,
      marketCap,
      removeOutliers,
      dynamicPools,
      timezone,
      fastCache,
    }));
  };
}

module.exports = { createGetTokenOhlcvData };
