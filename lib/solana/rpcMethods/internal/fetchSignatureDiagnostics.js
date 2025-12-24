'use strict';

const { createGetTransaction } = require('../getTransaction');
const { createGetSignatureStatus } = require('../getSignatureStatus');

/**
 * Fetch best-effort diagnostics for a signature using SolanaTracker RPC.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(signature: string, opts?: Object) => Promise<Object>}
 */
function createFetchSignatureDiagnostics(rpc) {
  const getSignatureStatus = createGetSignatureStatus(rpc);
  const getTransaction = createGetTransaction(rpc);

  return async function fetchSignatureDiagnostics(signature, opts = {}) {
    const diagnostics = {};

    try {
      const status = await getSignatureStatus(signature, opts.signatureStatusOptions);
      diagnostics.signatureStatus = status
        ? {
            confirmationStatus: status.confirmationStatus || null,
            err: status.err || null,
            slot: status.slot || null,
          }
        : null;
    } catch (err) {
      diagnostics.signatureStatusError = err?.message || String(err);
    }

    try {
      const tx = await getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
        ...(opts.transactionOptions || {}),
      });
      if (tx && tx.meta) {
        diagnostics.txMeta = {
          err: tx.err || null,
          fee: tx.meta.fee || null,
          logMessages: Array.isArray(tx.meta.logMessages)
            ? tx.meta.logMessages.slice(-10)
            : null,
        };
      } else {
        diagnostics.txMeta = null;
      }
    } catch (err) {
      diagnostics.txMetaError = err?.message || String(err);
    }

    return diagnostics;
  };
}

module.exports = { createFetchSignatureDiagnostics };
