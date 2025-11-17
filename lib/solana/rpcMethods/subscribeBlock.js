'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to block notifications.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(onUpdate: Function, opts?: Object) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeBlock(rpcSubs) {
  return async function subscribeBlock(onUpdate, opts = {}) {
    ensureSubscriptionMethod(rpcSubs, 'blockSubscribe', 'subscribeBlock');
    ensureSubscriptionMethod(rpcSubs, 'blockUnsubscribe', 'subscribeBlock');
    const { onError, ...subscribeOpts } = opts || {};

    try {
      const builder = rpcSubs.blockSubscribe(subscribeOpts);
      return openSubscription({
        builder,
        subscribeOptions: subscribeOpts,
        helperName: 'subscribeBlock',
        onUpdate,
        onError,
        rpcSubs,
        unsubscribeMethod: 'blockUnsubscribe',
      });
    } catch (error) {
      throw new Error(`subscribeBlock: failed to subscribe: ${error?.message || error}`);
    }
  };
}

module.exports = { createSubscribeBlock };
