'use strict';

const {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} = require('@solana/kit');

/**
 * Normalize a public key-like value into a base58 string.
 *
 * @param {*} value
 * @returns {string|null}
 */
function normalizePubkeyLike(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value.toBase58 === 'function') {
    try {
      const s = value.toBase58();
      return typeof s === 'string' && s ? s : null;
    } catch (_) {
      return null;
    }
  }

  if (typeof value.toString === 'function') {
    try {
      const s = value.toString();
      if (typeof s === 'string' && s && s !== '[object Object]') {
        return s;
      }
    } catch (_) {
      return null;
    }
  }

  if (value.publicKey) {
    return normalizePubkeyLike(value.publicKey);
  }
  if (value.pubkey) {
    return normalizePubkeyLike(value.pubkey);
  }

  return null;
}

function normalizeAccountKeyList(keys) {
  if (!Array.isArray(keys)) return [];
  return keys
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === 'string') return normalizePubkeyLike(entry);
      if (entry.pubkey) return normalizePubkeyLike(entry.pubkey);
      if (entry.publicKey) return normalizePubkeyLike(entry.publicKey);
      return normalizePubkeyLike(entry);
    })
    .filter(Boolean);
}

function decodeStaticAccountKeysFromWire(transactionWire) {
  if (!Array.isArray(transactionWire) || transactionWire.length === 0) {
    return [];
  }

  const encoded = transactionWire[0];
  const encoding = transactionWire[1];
  if (typeof encoded !== 'string') return [];
  if (encoding && typeof encoding === 'string' && !encoding.startsWith('base64')) {
    return [];
  }

  try {
    const txnBytes = getBase64Encoder().encode(encoded);
    const transaction = getTransactionDecoder().decode(txnBytes);
    const compiled = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes
    );
    return normalizeAccountKeyList(compiled.staticAccounts || []);
  } catch (_) {
    return [];
  }
}

function pickLoadedAddresses(meta, message) {
  const loaded =
    (meta && meta.loadedAddresses) ||
    (message && message.loadedAddresses) ||
    null;
  if (!loaded || typeof loaded !== 'object') {
    return { writable: [], readonly: [] };
  }
  return {
    writable: Array.isArray(loaded.writable) ? loaded.writable : [],
    readonly: Array.isArray(loaded.readonly) ? loaded.readonly : [],
  };
}

function pickStaticAccountKeys(message) {
  if (!message || typeof message !== 'object') return [];
  if (Array.isArray(message.accountKeys)) {
    return message.accountKeys;
  }
  if (Array.isArray(message.staticAccountKeys)) {
    return message.staticAccountKeys;
  }
  return [];
}

/**
 * Resolve the ordered account keys for a transaction, including loaded addresses.
 *
 * @param {Object} tx - Raw getTransaction response value or NormalizedTransaction.
 * @returns {{
 *   accountKeys: string[],
 *   staticKeys: string[],
 *   loadedAddresses: { writable: string[], readonly: string[] },
 *   source: string,
 * }}
 */
function resolveTransactionAccountKeys(tx) {
  if (!tx || typeof tx !== 'object') {
    return { accountKeys: [], staticKeys: [], loadedAddresses: { writable: [], readonly: [] }, source: 'empty' };
  }

  const rawCandidate = tx.raw;
  const hasRawShape = Array.isArray(rawCandidate) ||
    (rawCandidate && typeof rawCandidate === 'object' && (
      rawCandidate.transaction ||
      rawCandidate.message ||
      rawCandidate.meta
    ));
  const rawTx = hasRawShape ? rawCandidate : tx;
  const transaction = rawTx.transaction || rawTx;
  const message = transaction && transaction.message ? transaction.message : null;
  const meta = rawTx.meta || tx.meta || null;

  let staticKeys = normalizeAccountKeyList(pickStaticAccountKeys(message));
  let source = staticKeys.length ? 'message' : 'none';

  if (staticKeys.length === 0 && Array.isArray(transaction)) {
    staticKeys = decodeStaticAccountKeysFromWire(transaction);
    if (staticKeys.length) source = 'wire';
  }

  const loadedAddresses = pickLoadedAddresses(meta, message);
  const writable = normalizeAccountKeyList(loadedAddresses.writable);
  const readonly = normalizeAccountKeyList(loadedAddresses.readonly);

  return {
    accountKeys: staticKeys.concat(writable, readonly),
    staticKeys,
    loadedAddresses: { writable, readonly },
    source,
  };
}

module.exports = {
  normalizePubkeyLike,
  resolveTransactionAccountKeys,
};
