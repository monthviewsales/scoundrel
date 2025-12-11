'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to signature confirmation notifications.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(signature: string, onUpdate: Function, opts?: { commitment?: string, enableReceivedNotification?: boolean, onError?: Function }) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeSignature(rpcSubs) {
  return async function subscribeSignature(signature, onUpdate, opts = {}) {
    if (typeof signature !== 'string' || signature.trim() === '') {
      throw new Error('subscribeSignature: signature must be a non-empty string');
    }

    ensureSubscriptionMethod(rpcSubs, 'signatureSubscribe', 'subscribeSignature');
    ensureSubscriptionMethod(rpcSubs, 'signatureUnsubscribe', 'subscribeSignature');

    const { onError, ...subscribeOpts } = opts || {};

    try {
      const builder = rpcSubs.signatureSubscribe(signature, subscribeOpts);
      return openSubscription({
        builder,
        subscribeOptions: subscribeOpts,
        helperName: 'subscribeSignature',
        onUpdate,
        onError,
        rpcSubs,
        unsubscribeMethod: 'signatureUnsubscribe',
      });
    } catch (error) {
      throw new Error(`subscribeSignature: failed to subscribe: ${error?.message || error}`);
    }
  };
}

module.exports = {
  createSubscribeSignature,
};
