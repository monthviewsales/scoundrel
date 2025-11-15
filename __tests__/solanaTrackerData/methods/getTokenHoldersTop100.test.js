'use strict';

const { createGetTokenHoldersTop100 } = require('../../../lib/solanaTrackerData/methods/getTokenHoldersTop100');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenHoldersTop100', () => {
  test('invokes sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getTopHolders = jest.fn().mockResolvedValue({ holders: [] });
    const fn = createGetTokenHoldersTop100(ctx);

    await fn('Mint11111111111111111111111111111111111');

    expect(ctx.call).toHaveBeenCalledWith('getTokenHoldersTop100', expect.any(Function));
    expect(ctx.client.getTopHolders).toHaveBeenCalledWith('Mint11111111111111111111111111111111111');
  });

  test('requires token address', async () => {
    const fn = createGetTokenHoldersTop100(createMockContext());
    await expect(fn()).rejects.toThrow('tokenAddress is required');
  });
});
