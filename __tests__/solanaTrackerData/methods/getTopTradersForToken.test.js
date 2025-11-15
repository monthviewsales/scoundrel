'use strict';

const { createGetTopTradersForToken } = require('../../../lib/solanaTrackerData/methods/getTopTradersForToken');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTopTradersForToken', () => {
  test('calls sdk and returns payload', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenTopTraders = jest.fn().mockResolvedValue({ traders: [] });
    const fn = createGetTopTradersForToken(ctx);

    await fn('Mint1111');

    expect(ctx.call).toHaveBeenCalledWith('getTopTradersForToken', expect.any(Function));
    expect(ctx.client.getTokenTopTraders).toHaveBeenCalledWith('Mint1111');
  });

  test('requires token address', async () => {
    const fn = createGetTopTradersForToken(createMockContext());
    await expect(fn()).rejects.toThrow('tokenAddress is required');
  });
});
