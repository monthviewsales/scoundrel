'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

/**
 * Factory: fetch recent signatures for an address using SolanaTracker RPC.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(address: string, opts?: Object) => Promise<{address: string, signatures: Array, raw: *}>}
 */
function createGetSignaturesForAddress(rpc) {
  return async function getSignaturesForAddress(address, opts = {}) {
    ensureRpcMethod(rpc, 'getSignaturesForAddress', 'getSignaturesForAddress');
    if (typeof address !== 'string' || address.trim() === '') {
      throw new Error('getSignaturesForAddress: address must be a non-empty string');
    }

    try {
      const response = await resolveRpcResult(
        rpc.getSignaturesForAddress(address, opts)
      );
      const signatures = Array.isArray(response?.value)
        ? response.value
        : Array.isArray(response)
          ? response
          : [];

      return {
        address,
        signatures,
        raw: response,
      };
    } catch (error) {
      throw new Error(
        `getSignaturesForAddress: failed to fetch signatures: ${error?.message || error}`
      );
    }
  };
}

module.exports = { createGetSignaturesForAddress };
