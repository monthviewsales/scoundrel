'use strict';

const { createSearchTokens, serializeSearchParams } = require('../../../lib/solanaTrackerData/methods/searchTokens');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('searchTokens', () => {
  test('serializes params and calls sdk', async () => {
    const ctx = createMockContext();
    ctx.client.searchTokens = jest.fn().mockResolvedValue({ hits: [] });
    const fn = createSearchTokens(ctx);

    await fn({ query: 'dog', pools: ['pumpfun', 'raydium'], filters: { minMcap: 100_000 } });

    expect(ctx.call).toHaveBeenCalledWith('searchTokens', expect.any(Function));
    expect(ctx.client.searchTokens).toHaveBeenCalledWith({
      query: 'dog',
      pools: 'pumpfun,raydium',
      filters: JSON.stringify({ minMcap: 100000 }),
    });
  });

  test('requires at least one filter', async () => {
    const fn = createSearchTokens(createMockContext());
    await expect(fn({})).rejects.toThrow('provide at least one filter');
  });
});

describe('serializeSearchParams', () => {
  test('drops nullish values', () => {
    const result = serializeSearchParams({ a: null, b: ['x', 'y'], c: { foo: 1 } });
    expect(result).toEqual({ b: 'x,y', c: '{"foo":1}' });
  });
});
