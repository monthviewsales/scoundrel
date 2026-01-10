'use strict';

const { createUnsubscribeBlock } = require('../../../lib/solana/rpcMethods/unsubscribeBlock');

describe('createUnsubscribeBlock', () => {
  test('requires blockUnsubscribe on rpcSubs', async () => {
    const unsubscribeBlock = createUnsubscribeBlock({});
    await expect(unsubscribeBlock(1)).rejects.toThrow('subscriptions client does not provide blockUnsubscribe');
  });

  test('rejects missing subscription id', async () => {
    const rpcSubs = {
      blockUnsubscribe: jest.fn(),
    };
    const unsubscribeBlock = createUnsubscribeBlock(rpcSubs);
    await expect(unsubscribeBlock()).rejects.toThrow('subscriptionId is required');
  });

  test('returns the unsubscribe result', async () => {
    const send = jest.fn().mockResolvedValue(true);
    const rpcSubs = {
      blockUnsubscribe: jest.fn(() => ({ send })),
    };
    const unsubscribeBlock = createUnsubscribeBlock(rpcSubs);

    await expect(unsubscribeBlock(42)).resolves.toBe(true);
    expect(rpcSubs.blockUnsubscribe).toHaveBeenCalledWith(42);
    expect(send).toHaveBeenCalled();
  });

  test('wraps send errors', async () => {
    const send = jest.fn().mockRejectedValue(new Error('boom'));
    const rpcSubs = {
      blockUnsubscribe: jest.fn(() => ({ send })),
    };
    const unsubscribeBlock = createUnsubscribeBlock(rpcSubs);

    await expect(unsubscribeBlock(42)).rejects.toThrow('failed to unsubscribe: boom');
  });
});
