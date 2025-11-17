'use strict';

const { createSubscribeSlotsUpdates } = require('../../../lib/solana/rpcMethods/subscribeSlotsUpdates');

describe('createSubscribeSlotsUpdates', () => {
  test('streams slots updates', async () => {
    async function* generator() {
      yield { type: 'first' };
    }
    const iterator = generator();
    iterator.subscriptionId = 3;
    iterator.return = jest.fn(async () => ({ done: true }));

    const builder = { subscribe: jest.fn(async () => iterator) };
    const rpcSubs = {
      slotsUpdatesSubscribe: jest.fn(() => builder),
      slotsUpdatesUnsubscribe: jest.fn(async () => {}),
    };

    const updates = [];
    const subscribeSlotsUpdates = createSubscribeSlotsUpdates(rpcSubs);
    const subscription = await subscribeSlotsUpdates((update) => updates.push(update));

    await Promise.resolve();
    expect(updates).toEqual([{ type: 'first' }]);
    await subscription.unsubscribe();
    expect(rpcSubs.slotsUpdatesUnsubscribe).toHaveBeenCalledWith(3);
  });

  test('throws when missing subs methods', async () => {
    const subscribeSlotsUpdates = createSubscribeSlotsUpdates({ slotsUpdatesSubscribe: () => ({}) });
    await expect(subscribeSlotsUpdates(() => {})).rejects.toThrow(/slotsUpdatesUnsubscribe/);
  });
});
