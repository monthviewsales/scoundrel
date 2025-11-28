'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to logs notifications.
 *
 * This wraps SolanaTracker's logsSubscribe endpoint via the rpcSubs client.
 *
 * Usage (from rpcMethods):
 *   const sub = await rpcMethods.subscribeLogs({ mentions: [pubkey] }, (ev) => { ... });
 *   await sub.unsubscribe();
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(filter: object, onUpdate: Function, opts?: { onError?: Function }) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeLogs(rpcSubs) {
  return async function subscribeLogs(filter, onUpdate, opts = {}) {
    if (!filter || typeof filter !== 'object') {
      throw new Error('subscribeLogs: filter object is required');
    }

    ensureSubscriptionMethod(rpcSubs, 'logsSubscribe', 'subscribeLogs');
    ensureSubscriptionMethod(rpcSubs, 'logsUnsubscribe', 'subscribeLogs');

    const { onError } = opts || {};

    try {
      // Forward the filter directly; do not add extra RPC params here.
      const builder = rpcSubs.logsSubscribe(filter);
      return openSubscription({
        builder,
        subscribeOptions: { filter },
        helperName: 'subscribeLogs',
        onUpdate,
        onError,
        rpcSubs,
        unsubscribeMethod: 'logsUnsubscribe',
      });
    } catch (error) {
      throw new Error(`subscribeLogs: failed to subscribe: ${error?.message || error}`);
    }
  };
}

module.exports = {
  createSubscribeLogs,
};
