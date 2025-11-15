'use strict';

const { createGetTokenPrice } = require('../../../lib/solanaTrackerData/methods/getTokenPrice');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenPrice', () => {
  test('prefers mint field and passes includePriceChanges flag', async () => {
    const ctx = createMockContext();
    ctx.client.getPrice = jest.fn().mockResolvedValue({ price: 1 });
    const fn = createGetTokenPrice(ctx);

    await fn({ mint: 'Mint1111', includePriceChanges: true });

    expect(ctx.call).toHaveBeenCalledWith('getTokenPrice', expect.any(Function));
    expect(ctx.client.getPrice).toHaveBeenCalledWith('Mint1111', true);
  });

  test('requires a mint or tokenAddress', async () => {
    const fn = createGetTokenPrice(createMockContext());
    await expect(fn()).rejects.toThrow('mint or tokenAddress is required');
  });
});
