'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');
const { normalizeTokenAccount } = require('./internal/tokenAccountNormalizer');

/**
 * Factory: fetch SPL token accounts for an owner using SolanaTracker RPC.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(owner: string, opts?: Object) => Promise<{owner: string, accounts: Array}>}
 */
function createGetTokenAccountsByOwner(rpc) {
  return async function getTokenAccountsByOwner(owner, opts = {}) {
    ensureRpcMethod(rpc, 'getTokenAccountsByOwner', 'getTokenAccountsByOwner');
    if (typeof owner !== 'string' || owner.trim() === '') {
      throw new Error('getTokenAccountsByOwner: owner must be a non-empty string');
    }

    try {
      const response = await resolveRpcResult(rpc.getTokenAccountsByOwner(owner, opts));
      const rawAccounts = Array.isArray(response?.value)
        ? response.value
        : Array.isArray(response?.accounts)
          ? response.accounts
          : Array.isArray(response)
            ? response
            : [];

      const accounts = rawAccounts
        .map((entry) => normalizeTokenAccount(owner, entry))
        .filter(Boolean);

      return {
        owner,
        accounts,
        raw: response,
      };
    } catch (error) {
      throw new Error(`getTokenAccountsByOwner: failed to fetch accounts: ${error?.message || error}`);
    }
  };
}

module.exports = { createGetTokenAccountsByOwner };
