'use strict';

const { createGetTokenSnapshotAt } = require('../../../lib/solanaTrackerData/methods/getTokenSnapshotAt');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenSnapshotAt', () => {
  test('fetches price and info then combines', async () => {
    const ctx = createMockContext();
    ctx.client.getPriceAtTimestamp = jest.fn().mockResolvedValue({ price: 0.01 });
    ctx.client.getTokenInfo = jest.fn().mockResolvedValue({ token: { symbol: 'SCND' }, pools: [] });
    const fn = createGetTokenSnapshotAt(ctx);

    const result = await fn({ mint: 'Mint111', timestamp: 1700000000 });

    expect(ctx.client.getPriceAtTimestamp).toHaveBeenCalledWith('Mint111', 1700000000);
    expect(result.priceAt).toEqual({ usd: 0.01, time: 1700000000 });
    expect(result.token).toEqual({ symbol: 'SCND' });
  });

  test('requires timestamp', async () => {
    const fn = createGetTokenSnapshotAt(createMockContext());
    await expect(fn({ mint: 'Mint111' })).rejects.toThrow('timestamp (ts) is required');
  });
});
