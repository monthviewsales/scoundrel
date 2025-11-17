'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to slots-updates stream (leader schedule, skipped slots, etc.).
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(onUpdate: Function, opts?: Object) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeSlotsUpdates(rpcSubs) {
  return async function subscribeSlotsUpdates(onUpdate, opts = {}) {
    ensureSubscriptionMethod(rpcSubs, 'slotsUpdatesSubscribe', 'subscribeSlotsUpdates');
    ensureSubscriptionMethod(rpcSubs, 'slotsUpdatesUnsubscribe', 'subscribeSlotsUpdates');
    const { onError, ...subscribeOpts } = opts || {};

    try {
      const builder = rpcSubs.slotsUpdatesSubscribe(subscribeOpts);
      return openSubscription({
        builder,
        subscribeOptions: subscribeOpts,
        helperName: 'subscribeSlotsUpdates',
        onUpdate,
        onError,
        rpcSubs,
        unsubscribeMethod: 'slotsUpdatesUnsubscribe',
      });
    } catch (error) {
      throw new Error(`subscribeSlotsUpdates: failed to subscribe: ${error?.message || error}`);
    }
  };
}

module.exports = { createSubscribeSlotsUpdates };
