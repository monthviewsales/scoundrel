'use strict';

const { db } = require('./context');

function mapSecretRow(row) {
  if (!row) return null;
  return {
    secretId: row.secretId,
    walletId: row.walletId,
    cipherText: row.cipherText,
    iv: row.iv,
    authTag: row.authTag,
    algorithm: row.algorithm,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Insert or update an encrypted wallet secret.
 *
 * @param {Object} payload
 * @param {number} payload.walletId
 * @param {string} payload.cipherText
 * @param {string} payload.iv
 * @param {string} payload.authTag
 * @param {string} [payload.algorithm]
 * @returns {Object|null}
 */
function upsertWalletSecret(payload) {
  if (!payload || payload.walletId == null) {
    throw new Error('upsertWalletSecret: walletId is required');
  }
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO sc_wallet_secrets (
       wallet_id,
       cipher_text,
       iv,
       auth_tag,
       algorithm,
       created_at,
       updated_at
     ) VALUES (
       @wallet_id,
       @cipher_text,
       @iv,
       @auth_tag,
       @algorithm,
       @created_at,
       @updated_at
     )
     ON CONFLICT(wallet_id) DO UPDATE SET
       cipher_text = excluded.cipher_text,
       iv = excluded.iv,
       auth_tag = excluded.auth_tag,
       algorithm = excluded.algorithm,
       updated_at = excluded.updated_at`
  );

  stmt.run({
    wallet_id: payload.walletId,
    cipher_text: payload.cipherText,
    iv: payload.iv,
    auth_tag: payload.authTag,
    algorithm: payload.algorithm || 'aes-256-gcm',
    created_at: now,
    updated_at: now,
  });

  return getWalletSecretByWalletId(payload.walletId);
}

/**
 * Fetch a wallet secret by internal secret id.
 *
 * @param {number} secretId
 * @returns {Object|null}
 */
function getWalletSecretById(secretId) {
  if (!secretId && secretId !== 0) return null;
  const row = db.prepare(
    `SELECT
       secret_id AS secretId,
       wallet_id AS walletId,
       cipher_text AS cipherText,
       iv,
       auth_tag AS authTag,
       algorithm,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM sc_wallet_secrets
     WHERE secret_id = ?
     LIMIT 1`
  ).get(secretId);
  return mapSecretRow(row);
}

/**
 * Fetch a wallet secret by wallet id.
 *
 * @param {number} walletId
 * @returns {Object|null}
 */
function getWalletSecretByWalletId(walletId) {
  if (!walletId && walletId !== 0) return null;
  const row = db.prepare(
    `SELECT
       secret_id AS secretId,
       wallet_id AS walletId,
       cipher_text AS cipherText,
       iv,
       auth_tag AS authTag,
       algorithm,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM sc_wallet_secrets
     WHERE wallet_id = ?
     LIMIT 1`
  ).get(walletId);
  return mapSecretRow(row);
}

/**
 * Delete a secret by secret id.
 *
 * @param {number} secretId
 * @returns {boolean}
 */
function deleteWalletSecretById(secretId) {
  if (!secretId && secretId !== 0) return false;
  const res = db.prepare('DELETE FROM sc_wallet_secrets WHERE secret_id = ?').run(secretId);
  return !!(res && res.changes);
}

/**
 * Delete a secret by wallet id.
 *
 * @param {number} walletId
 * @returns {boolean}
 */
function deleteWalletSecretByWalletId(walletId) {
  if (!walletId && walletId !== 0) return false;
  const res = db.prepare('DELETE FROM sc_wallet_secrets WHERE wallet_id = ?').run(walletId);
  return !!(res && res.changes);
}

module.exports = {
  upsertWalletSecret,
  getWalletSecretById,
  getWalletSecretByWalletId,
  deleteWalletSecretById,
  deleteWalletSecretByWalletId,
};
