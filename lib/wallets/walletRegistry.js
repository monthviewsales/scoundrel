'use strict';

const BootyBox = require('../../db');
const logger = require('../logger');

/**
 * @typedef {Object} WalletRecord
 * @property {string|number} walletId
 * @property {string} alias
 * @property {string} pubkey
 * @property {'funding'|'strategy'|'kol'|'deployer'|'other'} usageType
 * @property {boolean} isDefaultFunding
 * @property {boolean} autoAttachWarchest
 * @property {string|null} strategy
 * @property {string|null} color
 * @property {boolean} hasPrivateKey
 * @property {('none'|'keychain'|'db_encrypted')} keySource
 * @property {string|null} keyRef
 * @property {number|Date} createdAt
 * @property {number|Date} updatedAt
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
 * By default, warchest wallets are treated as funding wallets in the broader model,
 * but callers may override the usageType and flags if needed.
 *
 * @param {Object} params
 * @param {string} params.alias
 * @param {string} params.pubkey
 * @param {string|null} [params.color]
 * @param {boolean} [params.hasPrivateKey=false]
 * @param {('none'|'keychain'|'db_encrypted')} [params.keySource='none']
 * @param {string|null} [params.keyRef]
 * @param {'funding'|'strategy'|'kol'|'deployer'|'other'} [params.usageType='funding']
 * @param {boolean} [params.isDefaultFunding=false]
 * @param {boolean} [params.autoAttachWarchest=false]
 * @param {string|null} [params.strategy=null]
 * @returns {Promise<WalletRecord>}
 */
async function addWallet({
  alias,
  pubkey,
  color = null,
  hasPrivateKey = false,
  keySource = 'none',
  keyRef = null,
  usageType = 'funding',
  isDefaultFunding = false,
  autoAttachWarchest = false,
  strategy = null,
}) {
  await BootyBox.init();
  return BootyBox.insertWarchestWallet({
    alias,
    pubkey,
    color,
    hasPrivateKey,
    keySource,
    keyRef,
    usageType,
    isDefaultFunding,
    autoAttachWarchest,
    strategy,
  });
}

/**
 * Update configurable wallet options such as usage type, auto-attach flag,
 * strategy binding, or default funding status.
 *
 * @param {string} alias
 * @param {Partial<WalletRecord>} updates
 * @returns {Promise<WalletRecord|null>}
 */
async function updateWalletOptions(alias, updates) {
  if (!alias) {
    throw new Error('updateWalletOptions requires a wallet alias');
  }
  await BootyBox.init();
  return BootyBox.updateWarchestWalletOptions(alias, updates || {});
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

/**
 * List wallets that are explicitly marked as funding wallets.
 *
 * @returns {Promise<WalletRecord[]>}
 */
async function listFundingWallets() {
  await BootyBox.init();
  return BootyBox.listFundingWallets();
}

/**
 * Fetch the single default funding wallet, if configured.
 *
 * @returns {Promise<WalletRecord|null>}
 */
async function getDefaultFundingWallet() {
  await BootyBox.init();
  return BootyBox.getDefaultFundingWallet();
}

/**
 * Mark a wallet as the default funding wallet using either alias or pubkey.
 * Any previous default funding wallet will be cleared.
 *
 * @param {string} identifier alias or pubkey
 * @returns {Promise<WalletRecord|null>}
 */
async function setDefaultFundingWallet(identifier) {
  if (!identifier) {
    throw new Error('setDefaultFundingWallet requires an alias or pubkey.');
  }
  await BootyBox.init();
  return BootyBox.setDefaultFundingWallet(identifier);
}

/**
 * List wallets by usage type. If usageType is omitted, all wallets are returned.
 *
 * @param {'funding'|'strategy'|'kol'|'deployer'|'other'} [usageType]
 * @returns {Promise<WalletRecord[]>}
 */
async function listWalletsByUsage(usageType) {
  await BootyBox.init();
  return BootyBox.listWalletsByUsage(usageType);
}

/**
 * List wallets configured to auto-attach to the warchest daemon.
 *
 * @returns {Promise<WalletRecord[]>}
 */
async function listAutoAttachedWarchestWallets() {
  await BootyBox.init();
  return BootyBox.listAutoAttachedWarchestWallets();
}

/**
 * List wallets that are tracked as KOLs (key opinion leaders / traders).
 *
 * @returns {Promise<WalletRecord[]>}
 */
async function listTrackedKolWallets() {
  await BootyBox.init();
  return BootyBox.listTrackedKolWallets();
}

module.exports = {
  getAllWallets,
  getWalletByAlias,
  addWallet,
  updateWalletOptions,
  updateWalletColor,
  deleteWallet,
  listFundingWallets,
  getDefaultFundingWallet,
  setDefaultFundingWallet,
  listWalletsByUsage,
  listAutoAttachedWarchestWallets,
  listTrackedKolWallets,
};
