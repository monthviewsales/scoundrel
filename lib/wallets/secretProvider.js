'use strict';

/**
 * Utilities for resolving private keys for wallets based on the sc_wallets schema.
 *
 * This module is intentionally narrow in scope:
 *  - It NEVER logs raw secrets.
 *  - It ONLY knows how to fetch secrets from the current process env
 *    (which can be backed by 1Password Environments, dotenvx, classic .env, etc.).
 *  - It does not construct Solana Keypair objects; callers can decide how to
 *    interpret the returned private key string (base58, JSON array, etc.).
 */

/**
 * @typedef {Object} WalletRow
 * @property {number} wallet_id
 * @property {string} alias
 * @property {string} pubkey
 * @property {('funding'|'strategy'|'kol'|'deployer'|'other')} usage_type
 * @property {0|1|boolean} has_private_key
 * @property {string} key_source
 * @property {string|null} key_ref
 */

function getAlias(wallet) {
  return (
    wallet.alias ||
    wallet.name ||
    wallet.wallet_alias ||
    '<unnamed-wallet>'
  );
}

function normalizeHasPrivateKey(value) {
  if (value === undefined || value === null) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return Boolean(value);
}

/**
 * Normalise the has_private_key flag from the DB into a boolean.
 *
 * @param {WalletRow} wallet
 * @returns {boolean}
 */
function hasUsablePrivateKey(wallet) {
  if (!wallet) return false;

  const flag =
    wallet.has_private_key !== undefined
      ? wallet.has_private_key
      : wallet.hasPrivateKey;

  return normalizeHasPrivateKey(flag);
}

/**
 * Resolve the private key string for a wallet using its key_source/key_ref fields.
 *
 * Currently supported key_source values:
 *  - 'env':           key_ref is the name of an environment variable that holds the secret
 *  - 'keychain':      key_ref is the wallet secret id stored in sc_wallet_secrets
 *  - 'db_encrypted':  legacy alias for keychain-backed secrets
 *  - 'plaintext_dev': key_ref is the secret itself (DEV/TEST ONLY)
 *  - 'none' / other:  treated as view-only; no private key is available
 *
 * @param {WalletRow} wallet
 * @param {Object} [options]
 * @param {boolean} [options.requirePrivateKey=true]  When true, throws if no usable key is available.
 * @returns {Promise<string|null>} The private key string, or null if not required / view-only.
 * @throws {Error} If a private key is required but cannot be resolved.
 */
async function getPrivateKeyForWallet(wallet, options) {
  const { requirePrivateKey = true } = options || {};

  if (!wallet) {
    if (requirePrivateKey) {
      throw new Error('getPrivateKeyForWallet: wallet is required');
    }
    return null;
  }

  const alias = getAlias(wallet);
  const keySourceRaw = wallet.key_source ?? wallet.keySource ?? 'none';
  const keySource = String(keySourceRaw).toLowerCase();
  const keyRef = wallet.key_ref ?? wallet.keyRef ?? null;

  if (!hasUsablePrivateKey(wallet)) {
    if (requirePrivateKey) {
      throw new Error(
        `Wallet "${alias}" does not have an attached private key (has_private_key=0)`
      );
    }
    return null;
  }

  if (keySource === 'env') {
    if (!keyRef) {
      throw new Error(
        `Wallet "${alias}" is configured with key_source=env but key_ref is NULL`
      );
    }

    const envValue = process.env[keyRef];
    if (!envValue) {
      throw new Error(
        `Environment variable "${keyRef}" for wallet "${alias}" is not set; ` +
          'ensure it exists in your 1Password Environment / .env configuration.'
      );
    }

    return envValue;
  }

  if (keySource === 'keychain' || keySource === 'db_encrypted') {
    const { loadWalletSecret } = require('./keystore');
    const walletId = wallet.wallet_id ?? wallet.walletId ?? null;
    try {
      return await loadWalletSecret({ keyRef, walletId });
    } catch (err) {
      const msg = err?.message || err;
      throw new Error(
        `Wallet "${alias}" failed to load keychain secret: ${msg}`
      );
    }
  }

  if (keySource === 'plaintext_dev') {
    const env = process.env.NODE_ENV || 'development';
    if (env === 'production') {
      throw new Error(
        `Wallet "${alias}" uses key_source=plaintext_dev, which is not allowed in production.`
      );
    }

    if (!keyRef) {
      throw new Error(
        `Wallet "${alias}" is configured with key_source=plaintext_dev but key_ref is NULL`
      );
    }

    return keyRef;
  }

  // Any other key_source is treated as unsupported/view-only for now.
  if (requirePrivateKey) {
    throw new Error(
      `Wallet "${alias}" has unsupported key_source="${wallet.key_source}" and no resolvable private key.`
    );
  }

  return null;
}

module.exports = {
  hasUsablePrivateKey,
  getPrivateKeyForWallet,
};
