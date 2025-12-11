'use strict';

const { createGetSolBalance } = require('./getSolBalance');
const { createGetTokenAccountsByOwner } = require('./getTokenAccountsByOwner');
const { createGetTokenAccountsByOwnerV2 } = require('./getTokenAccountsByOwnerV2');
const { createGetMultipleAccounts } = require('./getMultipleAccounts');
const { createGetFirstAvailableBlock } = require('./getFirstAvailableBlock');
const { createGetTransaction } = require('./getTransaction');
const { createSubscribeAccount } = require('./subscribeAccount');
const { createSubscribeBlock } = require('./subscribeBlock');
const { createSubscribeSlot } = require('./subscribeSlot');
const { createSubscribeSlotsUpdates } = require('./subscribeSlotsUpdates');
const { createSubscribeLogs } = require('./subscribeLogs');
const { createUnsubscribeLogs } = require('./unsubscribeLogs');
const { createSubscribeSignature } = require('./subscribeSignature');
const { createUnsubscribeSignature } = require('./unsubscribeSignature');

/**
 * Bind SolanaTracker RPC helper methods to provided clients.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @param {*} rpcSubs - WebSocket subscriptions client from createSolanaTrackerRPCClient().
 * @returns {Object} Bound RPC helper methods.
 */
function createRpcMethods(rpc, rpcSubs) {
  return {
    getSolBalance: createGetSolBalance(rpc),
    getTokenAccountsByOwner: createGetTokenAccountsByOwner(rpc),
    getTokenAccountsByOwnerV2: createGetTokenAccountsByOwnerV2(rpc),
    getMultipleAccounts: createGetMultipleAccounts(rpc),
    getFirstAvailableBlock: createGetFirstAvailableBlock(rpc),
    getTransaction: createGetTransaction(rpc),
    subscribeAccount: createSubscribeAccount(rpcSubs),
    subscribeBlock: createSubscribeBlock(rpcSubs),
    subscribeSlot: createSubscribeSlot(rpcSubs),
    subscribeSlotsUpdates: createSubscribeSlotsUpdates(rpcSubs),
    subscribeLogs: createSubscribeLogs(rpcSubs),
    unsubscribeLogs: createUnsubscribeLogs(rpcSubs),
    subscribeSignature: createSubscribeSignature(rpcSubs),
    unsubscribeSignature: createUnsubscribeSignature(rpcSubs),
  };
}

module.exports = { createRpcMethods };
