'use strict';

const { createGetTokenInformation } = require('../../../lib/solanaTrackerData/methods/getTokenInformation');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenInformation', () => {
  test('requests token info via sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenInfo = jest.fn().mockResolvedValue({ symbol: 'SCND' });
    const fn = createGetTokenInformation(ctx);

    const result = await fn('Mint11111111111111111111111111111111111');

    expect(ctx.call).toHaveBeenCalledWith('getTokenInformation', expect.any(Function));
    expect(ctx.client.getTokenInfo).toHaveBeenCalledWith('Mint11111111111111111111111111111111111');
    expect(result).toEqual({ symbol: 'SCND' });
  });

  test('throws on empty token', async () => {
    const fn = createGetTokenInformation(createMockContext());

    await expect(fn('')).rejects.toThrow('tokenAddress is required');
  });
});
