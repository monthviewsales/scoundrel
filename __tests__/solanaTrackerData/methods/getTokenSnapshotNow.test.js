'use strict';

const { createGetTokenSnapshotNow } = require('../../../lib/solanaTrackerData/methods/getTokenSnapshotNow');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenSnapshotNow', () => {
  test('fetches token info', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenInfo = jest.fn().mockResolvedValue({ token: { symbol: 'SCND' } });
    const fn = createGetTokenSnapshotNow(ctx);

    const result = await fn({ tokenAddress: 'Mint111' });

    expect(ctx.call).toHaveBeenCalledWith('getTokenSnapshotNow', expect.any(Function));
    expect(ctx.client.getTokenInfo).toHaveBeenCalledWith('Mint111');
    expect(result).toEqual({ token: { symbol: 'SCND' } });
  });

  test('requires mint', async () => {
    const fn = createGetTokenSnapshotNow(createMockContext());
    await expect(fn({})).rejects.toThrow('mint/tokenAddress is required');
  });
});
