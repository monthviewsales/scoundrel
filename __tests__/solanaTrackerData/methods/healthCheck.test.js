'use strict';

const { createHealthCheck } = require('../../../lib/solanaTrackerData/methods/healthCheck');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('healthCheck', () => {
  test('uses health ping when available', async () => {
    const ctx = createMockContext();
    ctx.client.health = { ping: jest.fn().mockResolvedValue('pong') };
    const fn = createHealthCheck(ctx);

    const result = await fn();

    expect(result.ok).toBe(true);
    expect(ctx.call).toHaveBeenCalledWith('healthCheck', expect.any(Function), { attempts: 2 });
    expect(ctx.client.health.ping).toHaveBeenCalled();
  });

  test('falls back to token info and reports error', async () => {
    const ctx = createMockContext();
    ctx.client.getTokenInfo = jest.fn().mockRejectedValue(new Error('fail'));
    const fn = createHealthCheck(ctx);

    const result = await fn();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('fail');
  });
});
