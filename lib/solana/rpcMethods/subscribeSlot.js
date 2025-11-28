'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to slot notifications.
 *
 * SolanaTracker's slotSubscribe variant does not accept any parameters, so this
 * helper ignores all options except onError and always calls slotSubscribe()
 * with no arguments.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(onUpdate: Function, opts?: { onError?: Function }) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeSlot(rpcSubs) {
  return async function subscribeSlot(onUpdate, opts = {}) {
    ensureSubscriptionMethod(rpcSubs, 'slotSubscribe', 'subscribeSlot');
    ensureSubscriptionMethod(rpcSubs, 'slotUnsubscribe', 'subscribeSlot');

    const { onError } = opts || {};

    try {
      // SolanaTracker's slotSubscribe takes no parameters.
      const builder = rpcSubs.slotSubscribe();
      return openSubscription({
        builder,
        // Nothing is sent to the RPC as params; this is just for local logging/debug.
        subscribeOptions: {},
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

module.exports = {
  createSubscribeSlot,
};