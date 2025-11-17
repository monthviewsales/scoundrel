'use strict';

const { createGetAthPrice } = require('../../../lib/solanaTrackerData/methods/getAthPrice');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getAthPrice', () => {
  test('requests ath for token', async () => {
    const ctx = createMockContext();
    ctx.client.getAthPrice = jest.fn().mockResolvedValue({});
    const fn = createGetAthPrice(ctx);

    await fn('MintATH');

    expect(ctx.call).toHaveBeenCalledWith('getAthPrice', expect.any(Function));
    expect(ctx.client.getAthPrice).toHaveBeenCalledWith('MintATH');
  });

  test('requires tokenAddress', async () => {
    const fn = createGetAthPrice(createMockContext());
    await expect(fn()).rejects.toThrow('tokenAddress is required');
  });
});
