'use strict';

const { createGetTokenPnl } = require('../../../lib/solanaTrackerData/methods/getTokenPnl');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenPnL', () => {
  test('passes wallet, token, and holding flag', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenPnL = jest.fn().mockResolvedValue({});
    const fn = createGetTokenPnl(ctx);

    await fn({ wallet: 'WALLET', tokenAddress: 'MintABC', holdingCheck: true });

    expect(ctx.call).toHaveBeenCalledWith('getTokenPnL', expect.any(Function));
    expect(ctx.client.getTokenPnL).toHaveBeenCalledWith('WALLET', 'MintABC', true);
  });

  test('requires wallet and tokenAddress', async () => {
    const fn = createGetTokenPnl(createMockContext());
    await expect(fn()).rejects.toThrow('wallet is required');
    await expect(fn({ wallet: 'WALLET' })).rejects.toThrow('tokenAddress is required');
  });
});
