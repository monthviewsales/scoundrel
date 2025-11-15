'use strict';

const { createGetLatestTokens } = require('../../../lib/solanaTrackerData/methods/getLatestTokens');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getLatestTokens', () => {
  test('defaults to page 1', async () => {
    const ctx = createMockContext();
    ctx.client.getLatestTokens = jest.fn().mockResolvedValue({ data: [] });
    const fn = createGetLatestTokens(ctx);

    await fn();

    expect(ctx.call).toHaveBeenCalledWith('getLatestTokens', expect.any(Function));
    expect(ctx.client.getLatestTokens).toHaveBeenCalledWith(1);
  });

  test('validates positive integer page', async () => {
    const fn = createGetLatestTokens(createMockContext());
    await expect(fn(0)).rejects.toThrow('page must be a positive integer');
  });
});
