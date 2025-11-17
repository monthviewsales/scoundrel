'use strict';

const { createGetWalletPnl } = require('../../../lib/solanaTrackerData/methods/getWalletPnl');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getWalletPnl', () => {
  test('calls sdk with proper flags', async () => {
    const ctx = createMockContext();
    ctx.client.getWalletPnL = jest.fn().mockResolvedValue({ summary: {} });
    const fn = createGetWalletPnl(ctx);

    await fn({ wallet: 'Wallet1111', showHistoricPnl: true, holdingCheck: true });

    expect(ctx.call).toHaveBeenCalledWith('getWalletPnl', expect.any(Function));
    expect(ctx.client.getWalletPnL).toHaveBeenCalledWith('Wallet1111', true, true, false);
  });

  test('requires wallet', async () => {
    const fn = createGetWalletPnl(createMockContext());
    await expect(fn({ wallet: '' })).rejects.toThrow('wallet is required');
  });
});
