'use strict';

const crypto = require('crypto');

const BootyBox = require('../../db');
const { getMasterKey } = require('./keychainProvider');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function ensureString(value, label) {
  const str = typeof value === 'string' ? value : String(value || '');
  if (!str.trim()) {
    throw new Error(`keystore: ${label} is required`);
  }
  return str;
}

function toBase64(input) {
  return Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input).toString('base64');
}

function fromBase64(input) {
  return Buffer.from(String(input || ''), 'base64');
}

/**
 * Encrypt a secret string using the Keychain-backed master key.
 *
 * @param {string} secret
 * @returns {Promise<{ cipherText: string, iv: string, authTag: string, algorithm: string }>}
 */
async function encryptSecret(secret) {
  const secretString = ensureString(secret, 'secret');
  const masterKey = await getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const cipherText = Buffer.concat([
    cipher.update(secretString, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    cipherText: toBase64(cipherText),
    iv: toBase64(iv),
    authTag: toBase64(authTag),
    algorithm: ALGORITHM,
  };
}

/**
 * Decrypt a secret record using the Keychain-backed master key.
 *
 * @param {Object} record
 * @returns {Promise<string>}
 */
async function decryptSecret(record) {
  if (!record) {
    throw new Error('keystore: secret record is required');
  }
  const algorithm = record.algorithm || ALGORITHM;
  const cipherText = record.cipherText || record.cipher_text;
  const iv = record.iv;
  const authTag = record.authTag || record.auth_tag;
  if (!cipherText || !iv || !authTag) {
    throw new Error('keystore: secret record missing cipher fields');
  }

  const masterKey = await getMasterKey();
  const decipher = crypto.createDecipheriv(algorithm, masterKey, fromBase64(iv));
  decipher.setAuthTag(fromBase64(authTag));
  const plaintext = Buffer.concat([
    decipher.update(fromBase64(cipherText)),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

/**
 * Store or update an encrypted secret for a wallet.
 *
 * @param {Object} params
 * @param {number} params.walletId
 * @param {string} params.secret
 * @returns {Promise<{ secretId: number }>}
 */
async function upsertWalletSecret({ walletId, secret }) {
  if (!walletId && walletId !== 0) {
    throw new Error('keystore: walletId is required');
  }
  await BootyBox.init();
  const encrypted = await encryptSecret(secret);
  const row = BootyBox.upsertWalletSecret({
    walletId,
    cipherText: encrypted.cipherText,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    algorithm: encrypted.algorithm,
  });
  if (!row || row.secretId == null) {
    throw new Error('keystore: failed to store wallet secret');
  }
  return { secretId: row.secretId };
}

/**
 * Load and decrypt a wallet secret using key_ref or wallet_id.
 *
 * @param {Object} params
 * @param {string|number|null} [params.keyRef]
 * @param {string|number|null} [params.walletId]
 * @returns {Promise<string>}
 */
async function loadWalletSecret({ keyRef, walletId }) {
  await BootyBox.init();
  let row = null;

  if (keyRef != null && keyRef !== '') {
    const id = Number(keyRef);
    if (!Number.isFinite(id)) {
      throw new Error('keystore: keyRef is not a numeric secret id');
    }
    row = BootyBox.getWalletSecretById(id);
  }

  if (!row && walletId != null) {
    row = BootyBox.getWalletSecretByWalletId(walletId);
  }

  if (!row) {
    throw new Error('keystore: wallet secret not found');
  }

  return decryptSecret(row);
}

/**
 * Delete a wallet secret by key_ref or wallet_id.
 *
 * @param {Object} params
 * @param {string|number|null} [params.keyRef]
 * @param {string|number|null} [params.walletId]
 * @returns {Promise<boolean>}
 */
async function deleteWalletSecret({ keyRef, walletId }) {
  await BootyBox.init();
  if (keyRef != null && keyRef !== '') {
    const id = Number(keyRef);
    if (!Number.isFinite(id)) return false;
    return !!BootyBox.deleteWalletSecretById(id);
  }
  if (walletId != null) {
    return !!BootyBox.deleteWalletSecretByWalletId(walletId);
  }
  return false;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  upsertWalletSecret,
  loadWalletSecret,
  deleteWalletSecret,
};
