'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

/**
 * Factory: fetch the first available block height from SolanaTracker.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {() => Promise<number>} Resolves to the earliest available block slot.
 */
function createGetFirstAvailableBlock(rpc) {
  return async function getFirstAvailableBlock() {
    ensureRpcMethod(rpc, 'getFirstAvailableBlock', 'getFirstAvailableBlock');

    try {
      const response = await resolveRpcResult(rpc.getFirstAvailableBlock());
      const slot = Number(response?.value ?? response);
      if (!Number.isFinite(slot)) {
        throw new Error('invalid RPC response');
      }
      return slot;
    } catch (error) {
      throw new Error(`getFirstAvailableBlock: failed to fetch block: ${error?.message || error}`);
    }
  };
}

module.exports = { createGetFirstAvailableBlock };
