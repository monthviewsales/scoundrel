'use strict';

const { createGetTokenPoolOhlcvData } = require('../../../lib/solanaTrackerData/methods/getTokenPoolOhlcvData');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenPoolOhlcvData', () => {
  test('calls pool chart endpoint', async () => {
    const ctx = createMockContext();
    ctx.client.getPoolChartData = jest.fn().mockResolvedValue({ candles: [] });
    const fn = createGetTokenPoolOhlcvData(ctx);

    await fn({ mint: 'Token111', poolAddress: 'Pool222', type: '1h' });

    expect(ctx.call).toHaveBeenCalledWith('getTokenPoolOhlcvData', expect.any(Function));
    expect(ctx.client.getPoolChartData).toHaveBeenCalledWith(expect.objectContaining({
      tokenAddress: 'Token111',
      poolAddress: 'Pool222',
      type: '1h',
    }));
  });

  test('requires pool address', async () => {
    const fn = createGetTokenPoolOhlcvData(createMockContext());
    await expect(fn({ tokenAddress: 'Token111' })).rejects.toThrow('poolAddress is required');
  });
});
