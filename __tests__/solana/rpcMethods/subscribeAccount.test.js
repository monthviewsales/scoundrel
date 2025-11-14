'use strict';

const { createSubscribeAccount } = require('../../../lib/solana/rpcMethods/subscribeAccount');

describe('createSubscribeAccount', () => {
  function makeIterator(values) {
    async function* generator() {
      for (const value of values) {
        yield value;
      }
    }
    const iterator = generator();
    iterator.subscriptionId = 42;
    const originalReturn = iterator.return?.bind(iterator);
    iterator.return = jest.fn(async (...args) => {
      if (originalReturn) {
        return originalReturn(...args);
      }
      return { done: true };
    });
    return iterator;
  }

  test('subscribes and forwards account updates', async () => {
    const updates = [];
    const iterator = makeIterator([{ lamports: 1 }, { lamports: 2 }]);
    const builder = { subscribe: jest.fn(async () => iterator) };
    const rpcSubs = {
      accountSubscribe: jest.fn(() => builder),
      accountUnsubscribe: jest.fn(async () => {}),
    };

    const subscribeAccount = createSubscribeAccount(rpcSubs);
    const subscription = await subscribeAccount('PubKey', (update) => updates.push(update), { commitment: 'confirmed' });

    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toEqual([{ lamports: 1 }, { lamports: 2 }]);
    expect(subscription.subscriptionId).toBe(42);

    await subscription.unsubscribe();
    expect(iterator.return).toHaveBeenCalled();
    expect(rpcSubs.accountUnsubscribe).toHaveBeenCalledWith(42);
  });

  test('propagates stream errors via onError', async () => {
    const iterator = (async function* erroring() {
      throw new Error('stream failure');
    })();
    iterator.subscriptionId = 7;
    iterator.return = jest.fn(async () => ({ done: true }));

    const builder = { subscribe: jest.fn(async () => iterator) };
    const rpcSubs = {
      accountSubscribe: jest.fn(() => builder),
      accountUnsubscribe: jest.fn(async () => {}),
    };

    const onError = jest.fn();
    const subscribeAccount = createSubscribeAccount(rpcSubs);
    await subscribeAccount('PubKey', () => {}, { onError });

    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  test('throws for missing pubkey or methods', async () => {
    const subscribeAccount = createSubscribeAccount({});
    await expect(subscribeAccount('  ', () => {})).rejects.toThrow(/non-empty string/);
    await expect(createSubscribeAccount({ accountSubscribe: () => {} })('Pub', () => {})).rejects.toThrow(/accountUnsubscribe/);
  });
});
