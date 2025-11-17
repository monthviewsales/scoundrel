'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to account change notifications via WebSocket RPC.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(pubkey: string, onUpdate: Function, opts?: Object) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeAccount(rpcSubs) {
  return async function subscribeAccount(pubkey, onUpdate, opts = {}) {
    if (typeof pubkey !== 'string' || pubkey.trim() === '') {
      throw new Error('subscribeAccount: pubkey must be a non-empty string');
    }
    ensureSubscriptionMethod(rpcSubs, 'accountSubscribe', 'subscribeAccount');
    ensureSubscriptionMethod(rpcSubs, 'accountUnsubscribe', 'subscribeAccount');

    const { onError, ...subscribeOpts } = opts || {};

    try {
      const builder = rpcSubs.accountSubscribe(pubkey, subscribeOpts);
      return openSubscription({
        builder,
        subscribeOptions: subscribeOpts,
        helperName: 'subscribeAccount',
        onUpdate,
        onError,
        rpcSubs,
        unsubscribeMethod: 'accountUnsubscribe',
      });
    } catch (error) {
      throw new Error(`subscribeAccount: failed to subscribe: ${error?.message || error}`);
    }
  };
}

module.exports = { createSubscribeAccount };
