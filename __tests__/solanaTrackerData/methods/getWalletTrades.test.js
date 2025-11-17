'use strict';

const { createGetWalletTrades } = require('../../../lib/solanaTrackerData/methods/getWalletTrades');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getWalletTrades', () => {
  test('fetches multiple pages until limit reached', async () => {
    const ctx = createMockContext();
    ctx.client.getWalletTrades = jest
      .fn()
      .mockResolvedValueOnce({
        trades: [{ sig: 'a', blockTime: 100 }],
        hasNextPage: true,
        nextCursor: 'abc',
      })
      .mockResolvedValueOnce({
        trades: [{ sig: 'b', blockTime: 200 }],
        hasNextPage: false,
      });

    const fn = createGetWalletTrades(ctx);
    const result = await fn({ wallet: 'Wallet1111', limit: 2 });

    expect(ctx.client.getWalletTrades).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(ctx.call).toHaveBeenCalledWith('getWalletTrades', expect.any(Function));
  });

  test('filters by optional start and end times', async () => {
    const ctx = createMockContext();
    ctx.client.getWalletTrades = jest.fn().mockResolvedValue({
      trades: [
        { sig: 'old', blockTime: 10 },
        { sig: 'mid', blockTime: 20 },
      ],
      hasNextPage: false,
    });

    const fn = createGetWalletTrades(ctx);
    const result = await fn({ wallet: 'Wallet1111', limit: 10, startTime: 15, endTime: 30 });

    expect(result).toEqual([{ sig: 'mid', blockTime: 20 }]);
  });

  test('validates wallet input', async () => {
    const fn = createGetWalletTrades(createMockContext());
    await expect(fn({ wallet: '' })).rejects.toThrow('wallet is required');
  });
});
