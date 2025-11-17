'use strict';

const { createGetTokenByPoolAddress } = require('../../../lib/solanaTrackerData/methods/getTokenByPoolAddress');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenByPoolAddress', () => {
  test('calls sdk with cleaned address', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenByPool = jest.fn().mockResolvedValue({ ok: true });
    const fn = createGetTokenByPoolAddress(ctx);

    await fn('  pool11111111111111111111111111111111111111  ');

    expect(ctx.call).toHaveBeenCalledWith('getTokenByPoolAddress', expect.any(Function));
    expect(ctx.client.getTokenByPool).toHaveBeenCalledWith('pool11111111111111111111111111111111111111');
  });

  test('throws when pool address missing', async () => {
    const fn = createGetTokenByPoolAddress(createMockContext());
    await expect(fn()).rejects.toThrow('poolAddress is required');
  });
});
