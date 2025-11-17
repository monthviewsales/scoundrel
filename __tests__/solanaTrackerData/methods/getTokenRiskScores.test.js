'use strict';

const { createGetTokenRiskScores, normalizeRiskPayload } = require('../../../lib/solanaTrackerData/methods/getTokenRiskScores');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokenRiskScores', () => {
  test('requests /risk endpoint and normalizes output', async () => {
    const ctx = createMockContext();
    ctx.client.request = jest.fn().mockResolvedValue({
      totalScore: 82,
      rating: 'medium',
      factors: [{ name: 'liquidity', score: 0.4, severity: 'high' }],
    });
    const fn = createGetTokenRiskScores(ctx);

    const result = await fn('Mint1111');

    expect(ctx.call).toHaveBeenCalledWith('getTokenRiskScores', expect.any(Function));
    expect(ctx.client.request).toHaveBeenCalledWith('/risk/Mint1111');
    expect(result).toMatchObject({
      token: 'Mint1111',
      score: 82,
      rating: 'medium',
      factors: [{ name: 'liquidity', score: 0.4, severity: 'high' }],
    });
  });

  test('requires token address', async () => {
    const fn = createGetTokenRiskScores({ client: { request: jest.fn() }, call: jest.fn() });
    await expect(fn('')).rejects.toThrow('tokenAddress is required');
  });
});

describe('normalizeRiskPayload', () => {
  test('handles object-based factors', () => {
    const payload = {
      score: 50,
      scores: {
        rug: { score: 0.1, severity: 'low' },
      },
    };
    const normalized = normalizeRiskPayload('Mint1111', payload);
    expect(normalized.factors[0]).toMatchObject({ name: 'rug', score: 0.1, severity: 'low' });
  });
});
