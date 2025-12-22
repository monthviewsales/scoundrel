'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

/**
 * Fetch a signature status via SolanaTracker RPC.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(signature: string, opts?: Object) => Promise<Object|null>}
 */
function createGetSignatureStatus(rpc) {
  ensureRpcMethod(rpc, 'getSignatureStatuses', 'getSignatureStatus');

  return async function getSignatureStatus(signature, opts = {}) {
    if (typeof signature !== 'string' || signature.trim() === '') {
      throw new Error('getSignatureStatus: signature must be a non-empty string');
    }

    const finalOpts = {
      searchTransactionHistory: true,
      ...opts,
    };

    const response = await resolveRpcResult(
      rpc.getSignatureStatuses([signature], finalOpts)
    );

    const value = response && response.value ? response.value[0] : null;
    if (!value) return null;

    return {
      signature,
      confirmationStatus: value.confirmationStatus || null,
      err: value.err || null,
      slot: value.slot || null,
      raw: value,
    };
  };
}

module.exports = { createGetSignatureStatus };
