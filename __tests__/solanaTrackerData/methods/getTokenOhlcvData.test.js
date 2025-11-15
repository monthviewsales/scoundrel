'use strict';

const { createGetTokenOhlcvData } = require('../../../lib/solanaTrackerData/methods/getTokenOhlcvData');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenOhlcvData', () => {
  test('passes structured params to sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getChartData = jest.fn().mockResolvedValue({ candles: [] });
    const fn = createGetTokenOhlcvData(ctx);

    await fn({ mint: 'Mint1111', type: '15m', marketCap: true });

    expect(ctx.call).toHaveBeenCalledWith('getTokenOhlcvData', expect.any(Function));
    expect(ctx.client.getChartData).toHaveBeenCalledWith(expect.objectContaining({
      tokenAddress: 'Mint1111',
      type: '15m',
      marketCap: true,
    }));
  });

  test('requires tokenAddress/mint', async () => {
    const fn = createGetTokenOhlcvData(createMockContext());
    await expect(fn()).rejects.toThrow('tokenAddress (mint) is required');
  });
});
