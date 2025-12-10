'use strict';

jest.mock('../../../lib/logger', () => ({
  warn: jest.fn(),
}));

const { withRetry, isRetryableError } = require('../../../lib/warchest/workers/retry');
const logger = require('../../../lib/logger');

describe('withRetry', () => {
  test('retries transient errors with exponential backoff', async () => {
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce('ok');

    const res = await withRetry(attempt, { delayFn: () => Promise.resolve(), attempts: 3 });

    expect(res).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('fails fast on non-retryable errors', async () => {
    const fatal = jest.fn().mockRejectedValue(new Error('bad-input'));

    await expect(withRetry(fatal, { delayFn: () => Promise.resolve() })).rejects.toThrow(
      /Retry failed after 3 attempts/i
    );
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  test('detects retryable errors via helper', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });
});
