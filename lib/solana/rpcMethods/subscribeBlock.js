'use strict';

const { ensureSubscriptionMethod, openSubscription } = require('./internal/subscriptionHelpers');

/**
 * Factory: subscribe to block notifications.
 *
 * Options for subscribeBlock:
 * - filter: 'all' | { mentionsAccountOrProgram: string } (defaults to 'all')
 * - onError?: (error: Error) => void
 * - This helper targets SolanaTracker's blockSubscribe, which only accepts a single
 *   filter parameter (e.g. 'all' or { mentionsAccountOrProgram: string }).
 *
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {(onUpdate: Function, opts?: Object) => Promise<{subscriptionId: number|null, unsubscribe: Function}>}
 */
function createSubscribeBlock(rpcSubs) {
  return async function subscribeBlock(onUpdate, opts = {}) {
    ensureSubscriptionMethod(rpcSubs, 'blockSubscribe', 'subscribeBlock');
    ensureSubscriptionMethod(rpcSubs, 'blockUnsubscribe', 'subscribeBlock');
    const {
      onError,
      filter = 'all',
    } = opts || {};

    try {
      // SolanaTracker's blockSubscribe variant takes only a single filter param, e.g.:
      //   blockSubscribe('all')
      //   blockSubscribe({ mentionsAccountOrProgram: <pubkey> })
      const builder = rpcSubs.blockSubscribe(filter);
      return openSubscription({
        builder,
        subscribeOptions: { filter },
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
