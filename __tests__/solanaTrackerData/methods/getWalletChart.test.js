'use strict';

const { createGetWalletChart } = require('../../../lib/solanaTrackerData/methods/getWalletChart');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getWalletChart', () => {
  test('returns chart data', async () => {
    const ctx = createMockContext();
    ctx.client.getWalletChart = jest.fn().mockResolvedValue({ chart: [1, 2, 3] });
    const fn = createGetWalletChart(ctx);

    const result = await fn('Wallet1111');

    expect(result).toEqual([1, 2, 3]);
    expect(ctx.call).toHaveBeenCalledWith('getWalletChart', expect.any(Function));
    expect(ctx.client.getWalletChart).toHaveBeenCalledWith('Wallet1111');
  });

  test('validates wallet string', async () => {
    const fn = createGetWalletChart(createMockContext());
    await expect(fn('')).rejects.toThrow('wallet is required');
  });
});
