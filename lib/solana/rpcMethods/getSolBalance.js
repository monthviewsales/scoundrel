'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

const LAMPORTS_PER_SOL = 1_000_000_000;

function extractLamports(payload) {
  if (payload == null) return null;
  if (typeof payload === 'number') return payload;
  if (typeof payload === 'string') {
    const parsed = Number(payload);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof payload === 'object') {
    if (typeof payload.value === 'number') return payload.value;
    if (payload.value != null) {
      const inner = extractLamports(payload.value);
      if (inner != null) return inner;
    }
    if (typeof payload.lamports === 'number') return payload.lamports;
    if (payload.lamports != null) {
      const innerLamports = extractLamports(payload.lamports);
      if (innerLamports != null) return innerLamports;
    }
    if (payload.data != null) {
      const innerData = extractLamports(payload.data);
      if (innerData != null) return innerData;
    }
  }
  return null;
}

/**
 * Create a helper that returns SOL balances as a floating point number.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(pubkey: string) => Promise<number>} - Function resolving to SOL balance.
 */
function createGetSolBalance(rpc) {
  return async function getSolBalance(pubkey) {
    ensureRpcMethod(rpc, 'getBalance', 'getSolBalance');
    if (typeof pubkey !== 'string' || pubkey.trim() === '') {
      throw new Error('getSolBalance: pubkey must be a non-empty string');
    }

    try {
      const response = await resolveRpcResult(rpc.getBalance(pubkey));
      const lamports = extractLamports(response);
      if (!Number.isFinite(lamports)) {
        throw new Error('invalid RPC response');
      }
      return lamports / LAMPORTS_PER_SOL;
    } catch (error) {
      throw new Error(`getSolBalance: failed to fetch balance: ${error?.message || error}`);
    }
  };
}

module.exports = { createGetSolBalance };
