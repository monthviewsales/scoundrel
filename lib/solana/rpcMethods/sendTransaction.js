'use strict';
const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

/**
 * Solana RPC: sendTransaction
 *
 * SolanaTracker documents this as a standard JSON-RPC method that returns the tx signature.
 * Their examples show the transaction provided as an encoded string with optional params.
 */

/**
 * @typedef {Object} SendTransactionOptions
 * @property {'base58'|'base64'} [encoding]
 * @property {boolean} [skipPreflight]
 * @property {string} [preflightCommitment]
 * @property {number} [maxRetries]
 * @property {number} [minContextSlot]
 */

/**
 * Factory for sendTransaction.
 *
 * NOTE: In Scoundrel, our swapV3 pipeline produces a base64 wire transaction.
 * Default encoding is therefore base64 unless overridden.
 *
 * @param {any} rpc
 * @returns {(wireTxn: string, options?: SendTransactionOptions) => Promise<string>}
 */
function createSendTransaction(rpc) {
  ensureRpcMethod(rpc, 'sendTransaction', 'sendTransaction');

  return async function sendTransaction(wireTxn, options = {}) {
    if (typeof wireTxn !== 'string' || wireTxn.trim().length === 0) {
      throw new Error('sendTransaction: wireTxn must be a non-empty string');
    }

    const sendOptions = {
      encoding: options.encoding || 'base64',
      ...options,
    };

    // Prefer typed method if present; fall back to generic request.
    const req = (rpc && typeof rpc.sendTransaction === 'function')
      ? rpc.sendTransaction(wireTxn, sendOptions)
      : rpc.request('sendTransaction', [wireTxn, sendOptions]);

    const txid = await resolveRpcResult(req);

    if (typeof txid !== 'string' || txid.length === 0) {
      throw new Error(`sendTransaction: unexpected result ${String(txid)}`);
    }

    return txid;
  };
}

module.exports = {
  createSendTransaction,
};
