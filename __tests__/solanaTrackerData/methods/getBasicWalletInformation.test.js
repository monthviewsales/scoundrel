'use strict';

const { createGetBasicWalletInformation } = require('../../../lib/solanaTrackerData/methods/getBasicWalletInformation');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getBasicWalletInformation', () => {
  test('calls sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getWalletBasic = jest.fn().mockResolvedValue({ label: 'demo' });
    const fn = createGetBasicWalletInformation(ctx);

    await fn('Wallet1111');

    expect(ctx.call).toHaveBeenCalledWith('getBasicWalletInformation', expect.any(Function));
    expect(ctx.client.getWalletBasic).toHaveBeenCalledWith('Wallet1111');
  });

  test('requires wallet', async () => {
    const fn = createGetBasicWalletInformation(createMockContext());
    await expect(fn('')).rejects.toThrow('wallet is required');
  });
});
