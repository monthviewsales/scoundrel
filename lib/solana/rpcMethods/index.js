'use strict';

const { createGetSolBalance } = require('./getSolBalance');
const { createGetTokenAccountsByOwner } = require('./getTokenAccountsByOwner');
const { createGetTokenAccountsByOwnerV2 } = require('./getTokenAccountsByOwnerV2');
const { createGetMultipleAccounts } = require('./getMultipleAccounts');
const { createGetFirstAvailableBlock } = require('./getFirstAvailableBlock');
const { createGetTransaction } = require('./getTransaction');
const { createGetSignaturesForAddress } = require('./getSignaturesForAddress');
const { createGetSignatureStatus } = require('./getSignatureStatus');
const { createFetchSignatureDiagnostics } = require('./internal/fetchSignatureDiagnostics');
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
    getSignaturesForAddress: createGetSignaturesForAddress(rpc),
    getSignatureStatus: createGetSignatureStatus(rpc),
    sendTransaction: (wireTxnBase64, sendOptions = {}) => {
      // Prefer native request-builder methods when available.
      if (rpc && typeof rpc.sendTransaction === 'function') {
        return rpc.sendTransaction(wireTxnBase64, sendOptions);
      }
      // Fallback to generic JSON-RPC request shape.
      if (rpc && typeof rpc.request === 'function') {
        return rpc.request('sendTransaction', [wireTxnBase64, sendOptions]);
      }
      throw new Error('RPC client does not support sendTransaction');
    },
    simulateTransaction: (wireTxnBase64, simOptions = {}) => {
      if (rpc && typeof rpc.simulateTransaction === 'function') {
        return rpc.simulateTransaction(wireTxnBase64, simOptions);
      }
      if (rpc && typeof rpc.request === 'function') {
        return rpc.request('simulateTransaction', [wireTxnBase64, simOptions]);
      }
      throw new Error('RPC client does not support simulateTransaction');
    },
    fetchSignatureDiagnostics: createFetchSignatureDiagnostics(rpc),
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
