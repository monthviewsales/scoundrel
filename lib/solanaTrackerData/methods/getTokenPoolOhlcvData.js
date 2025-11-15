'use strict';

/**
 * Bind helper for OHLCV chart data scoped to a token + pool pair.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { tokenAddress?: string, mint?: string, poolAddress: string, type?: string, timeFrom?: number, timeTo?: number, marketCap?: boolean, removeOutliers?: boolean, timezone?: string, fastCache?: boolean }) => Promise<any>}
 */
function createGetTokenPoolOhlcvData({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenPoolOhlcvData: missing dependencies');

  return async function getTokenPoolOhlcvData(options = {}) {
    const {
      tokenAddress,
      mint,
      poolAddress,
      type,
      timeFrom,
      timeTo,
      marketCap,
      removeOutliers,
      timezone,
      fastCache,
    } = options;

    const token = typeof mint === 'string' && mint.trim() !== '' ? mint.trim() : tokenAddress?.trim();
    if (!token) throw new Error('getTokenPoolOhlcvData: tokenAddress (mint) is required');
    if (typeof poolAddress !== 'string' || poolAddress.trim() === '') {
      throw new Error('getTokenPoolOhlcvData: poolAddress is required');
    }

    return call('getTokenPoolOhlcvData', () => client.getPoolChartData({
      tokenAddress: token,
      poolAddress: poolAddress.trim(),
      type,
      timeFrom,
      timeTo,
      marketCap,
      removeOutliers,
      timezone,
      fastCache,
    }));
  };
}

module.exports = { createGetTokenPoolOhlcvData };
