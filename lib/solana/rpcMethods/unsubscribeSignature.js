'use strict';

const { ensureSubscriptionMethod } = require('./internal/subscriptionHelpers');

/**
 * Factory: explicit unsubscribe helper for signature subscriptions.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client.
 * @returns {(subscriptionId: number) => Promise<void>}
 */
function createUnsubscribeSignature(rpcSubs) {
  return async function unsubscribeSignature(subscriptionId) {
    if (subscriptionId == null) {
      throw new Error('unsubscribeSignature: subscriptionId is required');
    }

    ensureSubscriptionMethod(rpcSubs, 'signatureUnsubscribe', 'unsubscribeSignature');

    try {
      await rpcSubs.signatureUnsubscribe(subscriptionId);
    } catch (error) {
      throw new Error(`unsubscribeSignature: failed to unsubscribe: ${error?.message || error}`);
    }
  };
}

module.exports = {
  createUnsubscribeSignature,
};
