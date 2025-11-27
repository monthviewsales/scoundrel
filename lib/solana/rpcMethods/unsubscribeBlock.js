'use strict';

const { ensureSubscriptionMethod } = require('../subscriptionHelpers');

/**
 * Factory: unsubscribe from block notifications.
 *
 * This is a thin wrapper around `rpcSubs.blockUnsubscribe` that performs
 * basic safety checks and normalizes errors.
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(subscriptionId: number) => Promise<*>}
 */
function createUnsubscribeBlock(rpcSubs) {
  return async function unsubscribeBlock(subscriptionId) {
    ensureSubscriptionMethod(rpcSubs, 'blockUnsubscribe', 'unsubscribeBlock');

    if (subscriptionId == null) {
      throw new Error('unsubscribeBlock: subscriptionId is required');
    }

    try {
      // Per Solana/SolanaTracker docs, blockUnsubscribe takes the
      // subscription id and returns a boolean result.
      const builder = rpcSubs.blockUnsubscribe(subscriptionId);
      const result = await builder.send();
      return result;
    } catch (error) {
      throw new Error(`unsubscribeBlock: failed to unsubscribe: ${error?.message || error}`);
    }
  };
}

module.exports = {
  createUnsubscribeBlock,
};
