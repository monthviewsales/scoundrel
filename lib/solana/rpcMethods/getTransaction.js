'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

/**
 * Factory: fetch a single confirmed transaction by signature.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(signature: string, opts?: Object) => Promise<object|null>} Normalized transaction payload.
 */
function createGetTransaction(rpc) {
  return async function getTransaction(signature, opts = {}) {
    ensureRpcMethod(rpc, 'getTransaction', 'getTransaction');
    if (typeof signature !== 'string' || signature.trim() === '') {
      throw new Error('getTransaction: signature must be a non-empty string');
    }

    try {
      const response = await resolveRpcResult(rpc.getTransaction(signature, opts));
      const hasValueField = response && Object.prototype.hasOwnProperty.call(response, 'value');
      const value = hasValueField ? response.value : response;
      if (value == null) return null;

      return {
        signature,
        slot: value.slot ?? null,
        blockTime: value.blockTime ?? value.block_time ?? null,
        transaction: value.transaction ?? null,
        meta: value.meta ?? null,
        raw: value,
      };
    } catch (error) {
      throw new Error(`getTransaction: failed to fetch transaction: ${error?.message || error}`);
    }
  };
}

module.exports = { createGetTransaction };
