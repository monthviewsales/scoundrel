'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

function normalizeAccount(pubkeys, entry, index) {
  if (!entry || typeof entry !== 'object') {
    return {
      pubkey: pubkeys[index] || null,
      lamports: null,
      owner: null,
      executable: false,
      rentEpoch: null,
      data: null,
      raw: entry,
    };
  }

  const accountInfo = entry.account || entry.value || entry;
  const lamports = Number(accountInfo?.lamports);

  return {
    pubkey: entry.pubkey || pubkeys[index] || null,
    lamports: Number.isFinite(lamports) ? lamports : null,
    owner: accountInfo?.owner || null,
    executable: Boolean(accountInfo?.executable),
    rentEpoch: accountInfo?.rentEpoch ?? null,
    data: accountInfo?.data ?? null,
    raw: entry,
  };
}

/**
 * Factory: load multiple account infos in a single RPC batch.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(pubkeys: string[], opts?: Object) => Promise<{accounts: Array}>}
 */
function createGetMultipleAccounts(rpc) {
  return async function getMultipleAccounts(pubkeys, opts = {}) {
    ensureRpcMethod(rpc, 'getMultipleAccounts', 'getMultipleAccounts');
    if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
      throw new Error('getMultipleAccounts: pubkeys must be a non-empty array');
    }

    try {
      const response = await resolveRpcResult(rpc.getMultipleAccounts(pubkeys, opts));
      const rawAccounts = Array.isArray(response?.value)
        ? response.value
        : Array.isArray(response)
          ? response
          : [];

      const accounts = rawAccounts.map((entry, index) => normalizeAccount(pubkeys, entry, index));

      return {
        accounts,
        raw: response,
      };
    } catch (error) {
      throw new Error(`getMultipleAccounts: failed to fetch accounts: ${error?.message || error}`);
    }
  };
}

module.exports = { createGetMultipleAccounts };
