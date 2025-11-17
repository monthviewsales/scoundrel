'use strict';

const { createGetTrendingTokens } = require('../../../lib/solanaTrackerData/methods/getTrendingTokens');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTrendingTokens', () => {
  test('passes timeframe to sdk', async () => {
    const ctx = createMockContext();
    ctx.client.getTrendingTokens = jest.fn().mockResolvedValue({ data: [] });
    const fn = createGetTrendingTokens(ctx);

    await fn({ timeframe: '1h' });

    expect(ctx.call).toHaveBeenCalledWith('getTrendingTokens', expect.any(Function));
    expect(ctx.client.getTrendingTokens).toHaveBeenCalledWith('1h');
  });

  test('validates timeframe', async () => {
    const fn = createGetTrendingTokens(createMockContext());
    await expect(fn({ timeframe: 'bad' })).rejects.toThrow('timeframe must be one of');
  });
});
