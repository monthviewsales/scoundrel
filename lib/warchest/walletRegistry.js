'use strict';

const crypto = require('crypto');
const BootyBox = require('../../packages/BootyBox');
const logger = require('../logger');

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
  await BootyBox.init();
  return BootyBox.listWarchestWallets();
}

/**
 * Look up a wallet by its alias.
 *
 * @param {string} alias
 * @returns {Promise<WalletRecord|null>}
 */
async function getWalletByAlias(alias) {
  await BootyBox.init();
  return BootyBox.getWarchestWalletByAlias(alias);
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
  await BootyBox.init();
  return BootyBox.insertWarchestWallet({
    alias,
    pubkey,
    color,
    hasPrivateKey,
    keySource,
    keyRef,
  });
}

/**
 * Update the display color for a wallet.
 *
 * @param {string} alias
 * @param {string|null} color
 * @returns {Promise<boolean>} true if a row was updated, false otherwise
 */
async function updateWalletColor(alias, color) {
  await BootyBox.init();
  return BootyBox.updateWarchestWalletColor(alias, color);
}

/**
 * Remove a wallet from the registry by alias.
 *
 * @param {string} alias
 * @returns {Promise<boolean>} true if a row was deleted, false otherwise
 */
async function deleteWallet(alias) {
  await BootyBox.init();
  return BootyBox.deleteWarchestWallet(alias);
}

module.exports = {
  getAllWallets,
  getWalletByAlias,
  addWallet,
  updateWalletColor,
  deleteWallet,
};
