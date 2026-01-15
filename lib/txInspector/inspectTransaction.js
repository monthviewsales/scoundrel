'use strict';

const path = require('path');
const {
  formatRunId,
  getArtifactConfig,
  sanitizeSegment,
  writeJsonArtifact,
} = require('../persist/jsonArtifacts');
const { resolveTransactionAccountKeys } = require('../solana/transactionAccounts');
const { computeSolChanges } = require('../solana/transactionDeltas');

const { saveRaw: SAVE_RAW } = getArtifactConfig();
const ARTIFACT_BASE_DIR = path.join(process.cwd(), 'data');

/**
 * Normalized per-account SOL balance change.
 *
 * @typedef {Object} AccountSolChange
 * @property {string} owner - Account pubkey.
 * @property {number} preLamports - Pre-transaction lamports.
 * @property {number} postLamports - Post-transaction lamports.
 * @property {number} deltaLamports - postLamports - preLamports.
 * @property {number} deltaSol - deltaLamports converted to SOL.
 */

/**
 * High-level inspection summary for a single transaction.
 *
 * This builds on top of the NormalizedTransaction returned by
 * rpcMethods.getTransaction(signatureOrSignatures, opts) and adds
 * convenience fields for the HUD, CLI, and future daemons.
 *
 * @typedef {Object} InspectTransactionSummary
 * @property {string} signature - Transaction signature.
 * @property {number|null} slot - Slot the transaction was processed in.
 * @property {number|null} blockTime - Unix timestamp (seconds) of the block.
 * @property {'ok'|'err'|'unknown'} status -
 *   'ok' if meta.err is explicitly null,
 *   'err' if meta.err is non-null,
 *   'unknown' if meta.err is missing.
 * @property {*} err - meta.err from RPC. null when the transaction executed successfully.
 * @property {number|null} networkFeeLamports - Network fee in lamports, if available.
 * @property {number|null} networkFeeSol - Network fee converted to SOL, if available.
 * @property {AccountSolChange[]} solChanges - Per-account SOL balance changes.
 * @property {*} rawMeta - Raw meta object from RPC (for advanced consumers).
 * @property {*} rawTransaction - Raw transaction object from RPC.
 * @property {*} raw - The full raw RPC "value" for advanced consumers.
 */


function isSaveRawEnabled() {
  return SAVE_RAW;
}

function maybeWriteInspectionArtifact(summary) {
  if (!isSaveRawEnabled() || !summary) return;

  const payload = {
    timestamp: new Date().toISOString(),
    summary,
  };

  try {
    const signatureSafe = sanitizeSegment(summary.signature, 'unknown-signature');
    writeJsonArtifact(
      ARTIFACT_BASE_DIR,
      ['txInspector', signatureSafe],
      `inspect-summary-${formatRunId()}.json`,
      payload,
    );
  } catch (err) {
    // Artifact writing is best-effort only; never break inspection.
  }
}

/**
 * Compute per-account SOL balance changes from a NormalizedTransaction.
 *
 * This inspects meta.preBalances/postBalances and transaction.message.accountKeys.
 * It is intentionally generic and does not attempt to label fee accounts or
 * specific programs yet; those will be layered on top in dedicated helpers.
 *
 * @param {import('../solana/rpcMethods/getTransaction').NormalizedTransaction} tx
 * @returns {AccountSolChange[]}
 * @private
 */

/**
 * Convert a NormalizedTransaction into an InspectTransactionSummary.
 *
 * @param {import('../solana/rpcMethods/getTransaction').NormalizedTransaction} tx
 * @returns {InspectTransactionSummary}
 * @private
 */
function normalizeInspection(tx) {
  if (!tx) {
    throw new Error('normalizeInspection: tx is required');
  }

  let networkFeeLamports = null;
  if (tx.meta && Object.prototype.hasOwnProperty.call(tx.meta, 'fee')) {
    const rawFee = tx.meta.fee;
    try {
      const n = typeof rawFee === 'bigint' ? Number(rawFee) : Number(rawFee);
      if (Number.isFinite(n)) {
        networkFeeLamports = n;
      }
    } catch (_) {
      // leave as null if we cannot safely convert
    }
  }

  let networkFeeSol = null;
  if (typeof networkFeeLamports === 'number' && Number.isFinite(networkFeeLamports)) {
    networkFeeSol = networkFeeLamports / 1_000_000_000;
  }

  const { accountKeys } = resolveTransactionAccountKeys(tx);
  const solChanges = computeSolChanges(tx.meta, accountKeys);

  const summary = {
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    status: tx.status,
    err: tx.err,
    networkFeeLamports,
    networkFeeSol,
    solChanges,
    rawMeta: tx.meta,
    rawTransaction: tx.transaction,
    raw: tx.raw,
  };

  // Best-effort debug artifact when enabled; never throws.
  maybeWriteInspectionArtifact(summary);

  return summary;
}

/**
 * Factory: create an inspectTransaction helper bound to a given rpcMethods object.
 *
 * Usage:
 *   const { rpc, rpcSubs } = createSolanaTrackerRPCClient();
 *   const rpcMethods = createRpcMethods(rpc, rpcSubs);
 *   const { createInspectTransaction } = require('../txInspector/inspectTransaction');
 *   const inspectTransaction = createInspectTransaction(rpcMethods);
 *
 *   // Single transaction
 *   const summary = await inspectTransaction('3sdfJ...fgG1', {
 *     maxSupportedTransactionVersion: 0,
 *   });
 *   // summary is an InspectTransactionSummary or null if not found.
 *
 *   // Batched transactions
 *   const summaries = await inspectTransaction([
 *     '3sdfJ...fgG1',
 *     'A3drg...kT82',
 *   ], {
 *     maxSupportedTransactionVersion: 0,
 *   });
 *   // summaries is an array of InspectTransactionSummary|null aligned with
 *   // the input signatures array.
 *
 * NOTE:
 * - This helper is intentionally generic: it focuses on SOL balance changes
 *   and network fees. Higher-level labeling (Jito tips, Pump.fun fees, Axiom
 *   fees, etc.) should be implemented in separate helpers that consume the
 *   returned summaries.
 *
 * @param {{ getTransaction: Function }} rpcMethods - Object returned from createRpcMethods().
 * @returns {(signatureOrSignatures: string|string[], opts?: Object) => Promise<InspectTransactionSummary|null|InspectTransactionSummary[]>}
 */
function createInspectTransaction(rpcMethods) {
  if (!rpcMethods || typeof rpcMethods.getTransaction !== 'function') {
    throw new Error('createInspectTransaction: rpcMethods.getTransaction is required');
  }

  return async function inspectTransaction(signatureOrSignatures, opts = {}) {
    // Single-signature usage
    if (!Array.isArray(signatureOrSignatures)) {
      const tx = await rpcMethods.getTransaction(signatureOrSignatures, opts);
      if (!tx) return null; // not found / expired
      return normalizeInspection(tx);
    }

    // Batched usage: array of signatures.
    const signatures = signatureOrSignatures;
    if (signatures.length === 0) return [];

    const txs = await rpcMethods.getTransaction(signatures, opts);
    if (!Array.isArray(txs)) {
      throw new Error('inspectTransaction: expected batched getTransaction to return an array');
    }

    return txs.map((tx) => (tx ? normalizeInspection(tx) : null));
  };
}

module.exports = {
  createInspectTransaction,
};
