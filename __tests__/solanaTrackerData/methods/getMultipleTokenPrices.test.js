'use strict';

const { createGetMultipleTokenPrices } = require('../../../lib/solanaTrackerData/methods/getMultipleTokenPrices');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getMultipleTokenPrices', () => {
  test('cleans tokens array', async () => {
    const ctx = createMockContext();
    ctx.client.getMultiplePrices = jest.fn().mockResolvedValue({ data: [] });
    const fn = createGetMultipleTokenPrices(ctx);

    await fn({ mints: [' A ', 'B'], includePriceChanges: true });

    expect(ctx.call).toHaveBeenCalledWith('getMultipleTokenPrices', expect.any(Function));
    expect(ctx.client.getMultiplePrices).toHaveBeenCalledWith(['A', 'B'], true);
  });

  test('requires array', async () => {
    const fn = createGetMultipleTokenPrices(createMockContext());
    await expect(fn({ mints: [] })).rejects.toThrow('non-empty array');
  });
});
