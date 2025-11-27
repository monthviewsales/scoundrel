'use strict';

const { ensureSubscriptionMethod } = require('./internal/subscriptionHelpers');

/**
 * Factory: direct unsubscribe helper for logs subscriptions.
 *
 * Most callers should use the unsubscribe() returned by subscribeLogs(),
 * but this is provided for feature parity with other unsubscribe helpers.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client.
 * @returns {(subscriptionId: number) => Promise<void>}
 */
function createUnsubscribeLogs(rpcSubs) {
  return async function unsubscribeLogs(subscriptionId) {
    if (subscriptionId == null) {
      throw new Error('unsubscribeLogs: subscriptionId is required');
    }

    ensureSubscriptionMethod(rpcSubs, 'logsUnsubscribe', 'unsubscribeLogs');

    try {
      await rpcSubs.logsUnsubscribe(subscriptionId);
    } catch (error) {
      throw new Error(`unsubscribeLogs: failed to unsubscribe: ${error?.message || error}`);
    }
  };
}

module.exports = {
  createUnsubscribeLogs,
};
