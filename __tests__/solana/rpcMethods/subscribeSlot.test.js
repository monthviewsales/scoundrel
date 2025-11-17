'use strict';

const { createSubscribeSlot } = require('../../../lib/solana/rpcMethods/subscribeSlot');

describe('createSubscribeSlot', () => {
  test('streams slot updates', async () => {
    async function* generator() {
      yield { slot: 10 };
      yield { slot: 11 };
    }
    const iterator = generator();
    iterator.subscriptionId = 11;
    iterator.return = jest.fn(async () => ({ done: true }));

    const builder = { subscribe: jest.fn(async () => iterator) };
    const rpcSubs = {
      slotSubscribe: jest.fn(() => builder),
      slotUnsubscribe: jest.fn(async () => {}),
    };

    const updates = [];
    const subscribeSlot = createSubscribeSlot(rpcSubs);
    const subscription = await subscribeSlot((update) => updates.push(update));

    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toEqual([{ slot: 10 }, { slot: 11 }]);
    await subscription.unsubscribe();
    expect(rpcSubs.slotUnsubscribe).toHaveBeenCalledWith(11);
  });

  test('throws when subs client missing methods', async () => {
    const subscribeSlot = createSubscribeSlot({ slotSubscribe: () => ({}) });
    await expect(subscribeSlot(() => {})).rejects.toThrow(/slotUnsubscribe/);
  });
});
