'use strict';

const { createGetTokenOverview } = require('../../../lib/solanaTrackerData/methods/getTokenOverview');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenOverview', () => {
  test('passes limit to sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenOverview = jest.fn().mockResolvedValue({ ok: true });
    const fn = createGetTokenOverview(ctx);

    await fn({ limit: 5 });

    expect(ctx.call).toHaveBeenCalledWith('getTokenOverview', expect.any(Function));
    expect(ctx.client.getTokenOverview).toHaveBeenCalledWith(5);
  });

  test('validates limit', async () => {
    const fn = createGetTokenOverview(createMockContext());
    await expect(fn({ limit: 0 })).rejects.toThrow('limit must be a positive integer');
  });
});
