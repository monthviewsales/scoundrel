'use strict';

const { createGetTokenEvents } = require('../../../lib/solanaTrackerData/methods/getTokenEvents');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenEvents', () => {
  test('calls sdk events endpoint', async () => {
    const ctx = createMockContext();
    ctx.client.getEvents = jest.fn().mockResolvedValue([{ type: 'buy' }]);
    const fn = createGetTokenEvents(ctx);

    await fn('Mint1111');

    expect(ctx.call).toHaveBeenCalledWith('getTokenEvents', expect.any(Function));
    expect(ctx.client.getEvents).toHaveBeenCalledWith('Mint1111');
  });

  test('requires token address', async () => {
    const fn = createGetTokenEvents(createMockContext());
    await expect(fn('')).rejects.toThrow('tokenAddress is required');
  });
});
