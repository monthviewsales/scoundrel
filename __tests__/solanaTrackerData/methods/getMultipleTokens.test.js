'use strict';

const { createGetMultipleTokens } = require('../../../lib/solanaTrackerData/methods/getMultipleTokens');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getMultipleTokens', () => {
  test('cleans addresses and calls sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getMultipleTokens = jest.fn().mockResolvedValue({ data: [] });
    const fn = createGetMultipleTokens(ctx);

    await fn([' mintA ', 'mintB']);

    expect(ctx.call).toHaveBeenCalledWith('getMultipleTokens', expect.any(Function));
    expect(ctx.client.getMultipleTokens).toHaveBeenCalledWith(['mintA', 'mintB']);
  });

  test('requires non-empty array', async () => {
    const fn = createGetMultipleTokens(createMockContext());
    await expect(fn([])).rejects.toThrow('non-empty array');
  });
});
