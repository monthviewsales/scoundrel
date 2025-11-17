'use strict';

const { createGetPriceRange } = require('../../../lib/solanaTrackerData/methods/getPriceRange');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getPriceRange', () => {
  test('calls sdk with token and window', async () => {
    const ctx = createMockContext();
    ctx.client.getPriceRange = jest.fn().mockResolvedValue({});
    const fn = createGetPriceRange(ctx);

    await fn('Mint123', 100, 200);

    expect(ctx.call).toHaveBeenCalledWith('getPriceRange', expect.any(Function));
    expect(ctx.client.getPriceRange).toHaveBeenCalledWith('Mint123', 100, 200);
  });

  test('requires params', async () => {
    const fn = createGetPriceRange(createMockContext());

    await expect(fn()).rejects.toThrow('tokenAddress is required');
    await expect(fn('Mint123')).rejects.toThrow('timeFrom and timeTo are required numbers');
  });
});
