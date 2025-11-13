'use strict';

const crypto = require('crypto');
const db = require('../db/mysql');

/**
 * Generate a pseudo-ULID style 26 character identifier for sc_wallets.wallet_id.
 * This does not need to be globally sortable; it just needs to be unique for this app.
 *
 * @returns {string}
 */
function generateWalletId() {
  // 16 random bytes -> base36 string -> trimmed/padded to 26 chars
  const buf = crypto.randomBytes(16);
  const base36 = BigInt('0x' + buf.toString('hex')).toString(36);
  return base36.padStart(26, '0').slice(-26);
}

/**
 * @typedef {Object} WalletRecord
 * @property {string} walletId
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} color
 * @property {boolean} hasPrivateKey
 * @property {('none'|'keychain'|'db_encrypted')} keySource
 * @property {string|null} keyRef
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * Fetch all wallets from the warchest registry, ordered by alias.
 *
 * @returns {Promise<WalletRecord[]>}
 */
async function getAllWallets() {
  const [rows] = await db.query(
    `SELECT
       wallet_id      AS walletId,
       alias,
       pubkey,
       color,
       has_private_key AS hasPrivateKey,
       key_source      AS keySource,
       key_ref         AS keyRef,
       created_at      AS createdAt,
       updated_at      AS updatedAt
     FROM sc_wallets
     ORDER BY alias ASC`
  );

  return rows.map((row) => ({
    ...row,
    hasPrivateKey: !!row.hasPrivateKey,
  }));
}

/**
 * Look up a wallet by its alias.
 *
 * @param {string} alias
 * @returns {Promise<WalletRecord|null>}
 */
async function getWalletByAlias(alias) {
  const [rows] = await db.query(
    `SELECT
       wallet_id      AS walletId,
       alias,
       pubkey,
       color,
       has_private_key AS hasPrivateKey,
       key_source      AS keySource,
       key_ref         AS keyRef,
       created_at      AS createdAt,
       updated_at      AS updatedAt
     FROM sc_wallets
     WHERE alias = ?
     LIMIT 1`,
    [alias]
  );

  if (!rows || rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    ...row,
    hasPrivateKey: !!row.hasPrivateKey,
  };
}

/**
 * Add a new wallet in the registry.
 *
 * @param {Object} params
 * @param {string} params.alias
 * @param {string} params.pubkey
 * @param {string|null} [params.color]
 * @param {boolean} [params.hasPrivateKey=false]
 * @param {('none'|'keychain'|'db_encrypted')} [params.keySource='none']
 * @param {string|null} [params.keyRef]
 * @returns {Promise<WalletRecord>}
 */
async function addWallet({
  alias,
  pubkey,
  color = null,
  hasPrivateKey = false,
  keySource = 'none',
  keyRef = null,
}) {
  const walletId = generateWalletId();

  await db.query(
    `INSERT INTO sc_wallets (
       wallet_id,
       alias,
       pubkey,
       color,
       has_private_key,
       key_source,
       key_ref
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      walletId,
      alias,
      pubkey,
      color,
      hasPrivateKey ? 1 : 0,
      keySource,
      keyRef,
    ]
  );

  // Return the freshly created record using the canonical selector
  return getWalletByAlias(alias);
}

/**
 * Update the display color for a wallet.
 *
 * @param {string} alias
 * @param {string|null} color
 * @returns {Promise<boolean>} true if a row was updated, false otherwise
 */
async function updateWalletColor(alias, color) {
  const [result] = await db.query(
    'UPDATE sc_wallets SET color = ? WHERE alias = ?',
    [color, alias]
  );

  return result && result.affectedRows > 0;
}

/**
 * Remove a wallet from the registry by alias.
 *
 * @param {string} alias
 * @returns {Promise<boolean>} true if a row was deleted, false otherwise
 */
async function deleteWallet(alias) {
  const [result] = await db.query(
    'DELETE FROM sc_wallets WHERE alias = ?',
    [alias]
  );

  return result && result.affectedRows > 0;
}

module.exports = {
  generateWalletId,
  getAllWallets,
  getWalletByAlias,
  addWallet,
  updateWalletColor,
  deleteWallet,
};