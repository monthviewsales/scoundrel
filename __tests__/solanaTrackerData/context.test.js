'use strict';

const {
  createDataClientContext,
  DataApiError,
  RateLimitError,
  ValidationError,
} = require('../../lib/solanaTrackerData/context');

describe('solanaTrackerData call retry behavior', () => {
  const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retries on rate limit errors and respects retryAfter', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const { call } = createDataClientContext({
      apiKey: 'test-key',
      baseUrl: 'http://example',
      maxAttempts: 2,
      retryBaseMs: 10,
      logger,
    });

    const exec = jest.fn()
      .mockRejectedValueOnce(new RateLimitError('rate limited', 1))
      .mockResolvedValue('ok');

    const promise = call('getToken', exec);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe('ok');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    setTimeoutSpy.mockRestore();
    jest.useRealTimers();
  });

  test('retries on server errors and succeeds on retry', async () => {
    jest.useFakeTimers();
    const { call } = createDataClientContext({
      apiKey: 'test-key',
      baseUrl: 'http://example',
      maxAttempts: 2,
      retryBaseMs: 5,
      logger,
    });

    const exec = jest.fn()
      .mockRejectedValueOnce(new DataApiError('server blew up', 500))
      .mockResolvedValue({ ok: true });

    const promise = call('getToken', exec);
    await jest.advanceTimersByTimeAsync(5);

    await expect(promise).resolves.toEqual({ ok: true });
    expect(exec).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  test('does not retry on validation errors and adds context', async () => {
    const { call } = createDataClientContext({
      apiKey: 'test-key',
      baseUrl: 'http://example',
      maxAttempts: 3,
      retryBaseMs: 5,
      logger,
    });

    const exec = jest.fn().mockRejectedValue(new ValidationError('bad input'));

    await expect(call('getToken', exec)).rejects.toThrow('[SolanaTrackerData.getToken]');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
