// lib/wallets/getWalletPrivateKey.js
'use strict';

const registry = require('./walletRegistry');
const { getPrivateKeyForWallet } = require('./secretProvider');

/**
 * Resolve a wallet's private key string (id.json array or base58)
 * from the wallet registry + env, given an alias.
 *
 * @param {string} aliasOrAddress
 * @returns {Promise<string>}
 */
module.exports = async function getWalletPrivateKey(aliasOrAddress) {
  const trimmed = String(aliasOrAddress || '').trim();
  if (!trimmed) {
    throw new Error('getWalletPrivateKey: alias or address is required');
  }

  // For now, just support alias; you can add address lookup later.
  const wallet = await registry.getWalletByAlias(trimmed);
  if (!wallet) {
    throw new Error(`No wallet found for alias "${trimmed}"`);
  }

  const secret = getPrivateKeyForWallet(wallet, { requirePrivateKey: true });
  if (!secret) {
    throw new Error(`Wallet "${wallet.alias}" has no usable private key`);
  }

  return secret;
};
