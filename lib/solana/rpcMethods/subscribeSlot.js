'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to slot notifications.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(onUpdate: Function, opts?: Object) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeSlot(rpcSubs) {
  return async function subscribeSlot(onUpdate, opts = {}) {
    ensureSubscriptionMethod(rpcSubs, 'slotSubscribe', 'subscribeSlot');
    ensureSubscriptionMethod(rpcSubs, 'slotUnsubscribe', 'subscribeSlot');
    const { onError, ...subscribeOpts } = opts || {};

    try {
      const builder = rpcSubs.slotSubscribe(subscribeOpts);
      return openSubscription({
        builder,
        subscribeOptions: subscribeOpts,
        helperName: 'subscribeSlot',
        onUpdate,
        onError,
        rpcSubs,
        unsubscribeMethod: 'slotUnsubscribe',
      });
    } catch (error) {
      throw new Error(`subscribeSlot: failed to subscribe: ${error?.message || error}`);
    }
  };
}

module.exports = { createSubscribeSlot };
