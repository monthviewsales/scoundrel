'use strict';

const { createSubscribeBlock } = require('../../../lib/solana/rpcMethods/subscribeBlock');

describe('createSubscribeBlock', () => {
  function makeIterator(values) {
    async function* generator() {
      for (const value of values) {
        yield value;
      }
    }
    const iterator = generator();
    iterator.subscriptionId = 9;
    iterator.return = jest.fn(async () => ({ done: true }));
    return iterator;
  }

  test('streams block updates', async () => {
    const iterator = makeIterator([{ slot: 1 }, { slot: 2 }]);
    const builder = { subscribe: jest.fn(async () => iterator) };
    const rpcSubs = {
      blockSubscribe: jest.fn(() => builder),
      blockUnsubscribe: jest.fn(async () => {}),
    };
    const updates = [];

    const subscribeBlock = createSubscribeBlock(rpcSubs);
    const subscription = await subscribeBlock((update) => updates.push(update));

    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toEqual([{ slot: 1 }, { slot: 2 }]);
    expect(subscription.subscriptionId).toBe(9);
    await subscription.unsubscribe();
    expect(iterator.return).toHaveBeenCalled();
    expect(rpcSubs.blockUnsubscribe).toHaveBeenCalledWith(9);
  });

  test('throws when methods missing', async () => {
    const subscribeBlock = createSubscribeBlock({});
    await expect(subscribeBlock(() => {})).rejects.toThrow(/blockSubscribe/);
  });
});
