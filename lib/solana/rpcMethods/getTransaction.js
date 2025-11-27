'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');

/**
 * Normalized transaction payload returned by getTransaction.
 *
 * @typedef {Object} NormalizedTransaction
 * @property {string} signature - Transaction signature.
 * @property {number|null} slot - Slot the transaction was processed in.
 * @property {number|null} blockTime - Unix timestamp (seconds) of the block, if available.
 * @property {*} transaction - Raw transaction object from RPC (wire format).
 * @property {*} meta - Raw meta object from RPC, including logs, balance changes, etc.
 * @property {*} err - meta.err from RPC. null when the transaction executed successfully.
 * @property {'ok'|'err'|'unknown'} status -
 *   'ok' if meta.err is explicitly null,
 *   'err' if meta.err is non-null,
 *   'unknown' if meta.err is missing.
 * @property {*} raw - The full raw RPC "value" for advanced consumers.
 */

/**
 * Factory: fetch one or many confirmed transactions by signature.
 *
 * This helper supports both single and batched usage while keeping a single
 * call-site API. It always uses SolanaTracker's `getTransaction` under the
 * hood, and the batching behaviour is implemented client-side so we can later
 * swap in a true HTTP JSON-RPC batch without changing callers.
 *
 * Usage:
 *   // Single transaction
 *   const tx = await getTransaction('3sdfJ...fgG1', {
 *     maxSupportedTransactionVersion: 0,
 *   });
 *   // tx is a NormalizedTransaction or null if not found.
 *
 *   // Batched transactions
 *   const txs = await getTransaction([
 *     '3sdfJ...fgG1',
 *     'A3drg...kT82',
 *   ], {
 *     maxSupportedTransactionVersion: 0,
 *   });
 *   // txs is an array of NormalizedTransaction|null aligned with the input
 *   // signatures array.
 *
 * IMPORTANT:
 * - On-chain execution errors are surfaced via `meta.err`, exposed here as
 *   `err` and `status: 'err'`. This lets callers distinguish between
 *   "confirmed but failed" vs "confirmed and successful".
 * - RPC-level or network errors will cause this method to throw.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(signatureOrSignatures: string|string[], opts?: Object) => Promise<NormalizedTransaction|null|NormalizedTransaction[]>}
 */
function createGetTransaction(rpc) {
  ensureRpcMethod(rpc, 'getTransaction', 'getTransaction');

  /**
   * Fetch and normalize a single transaction by signature.
   *
   * @param {string} signature
   * @param {Object} opts
   * @returns {Promise<NormalizedTransaction|null>}
   * @private
   */
  async function fetchOne(signature, opts) {
    if (typeof signature !== 'string' || signature.trim() === '') {
      throw new Error('getTransaction: signature must be a non-empty string');
    }

    try {
      const response = await resolveRpcResult(rpc.getTransaction(signature, opts));
      const hasValueField = response && Object.prototype.hasOwnProperty.call(response, 'value');
      const value = hasValueField ? response.value : response;
      if (value == null) return null; // not found / expired

      const slot = Object.prototype.hasOwnProperty.call(value, 'slot') ? value.slot : null;
      const blockTime =
        Object.prototype.hasOwnProperty.call(value, 'blockTime')
          ? value.blockTime
          : (Object.prototype.hasOwnProperty.call(value, 'block_time') ? value.block_time : null);
      const transaction = Object.prototype.hasOwnProperty.call(value, 'transaction') ? value.transaction : null;
      const meta = Object.prototype.hasOwnProperty.call(value, 'meta') ? value.meta : null;

      let err = null;
      let status = 'unknown';

      if (meta && Object.prototype.hasOwnProperty.call(meta, 'err')) {
        err = meta.err;
        status = meta.err == null ? 'ok' : 'err';
      }

      return {
        signature,
        slot,
        blockTime,
        transaction,
        meta,
        err,
        status,
        raw: value,
      };
    } catch (error) {
      throw new Error(`getTransaction: failed to fetch transaction for ${signature}: ${error?.message || error}`);
    }
  }

  return async function getTransaction(signatureOrSignatures, opts = {}) {
    // Single-signature usage
    if (!Array.isArray(signatureOrSignatures)) {
      return fetchOne(signatureOrSignatures, opts);
    }

    // Batched usage: array of signatures.
    const signatures = signatureOrSignatures;
    if (signatures.length === 0) return [];

    // For now we simply issue one RPC call per signature in parallel. This is
    // a safe "soft batch" implementation. If the underlying RPC client gains
    // native JSON-RPC batch support, we can replace this with a true batch
    // call without changing the public API.
    const results = await Promise.all(signatures.map((sig) => fetchOne(sig, opts)));
    return results;
  };
}

module.exports = { createGetTransaction };
