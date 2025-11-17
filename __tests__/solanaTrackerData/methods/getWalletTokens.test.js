'use strict';

const { createGetWalletTokens } = require('../../../lib/solanaTrackerData/methods/getWalletTokens');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getWalletTokens', () => {
  test('uses getWallet when page missing', async () => {
    const ctx = createMockContext();
    ctx.client.getWallet = jest.fn().mockResolvedValue({ tokens: [] });
    const fn = createGetWalletTokens(ctx);

    await fn({ wallet: 'Wallet1111' });

    expect(ctx.call).toHaveBeenCalledWith('getWalletTokens', expect.any(Function));
    expect(ctx.client.getWallet).toHaveBeenCalledWith('Wallet1111');
  });

  test('routes to paged endpoint when page provided', async () => {
    const ctx = createMockContext();
    ctx.client.getWalletPage = jest.fn().mockResolvedValue({ tokens: [] });
    const fn = createGetWalletTokens(ctx);

    await fn({ wallet: 'Wallet1111', page: 2 });

    expect(ctx.client.getWalletPage).toHaveBeenCalledWith('Wallet1111', 2);
  });

  test('validates wallet string', async () => {
    const fn = createGetWalletTokens(createMockContext());
    await expect(fn({ wallet: '' })).rejects.toThrow('wallet is required');
  });
});
