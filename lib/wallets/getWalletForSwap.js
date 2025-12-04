'use strict';

const { createKeyPairSignerFromBytes } = require('@solana/kit');
const { hasUsablePrivateKey, getPrivateKeyForWallet } = require('./secretProvider');
const registry = require('./registry');

/**
 * @typedef {import('./secretProvider').WalletRow} WalletRow
 */

/**
 * Build a swap-ready runtime wallet object from a sc_wallets row or wallet alias.
 *
 * This helper is intentionally narrow in scope:
 *  - It does NOT perform any database lookups; callers must provide the wallet row or alias.
 *  - It does NOT perform any swaps or RPC calls.
 *  - It ONLY:
 *      * resolves the private key via secretProvider
 *      * constructs a Solana Kit signer from that key
 *      * returns a structured runtime wallet object
 *
 * @param {WalletRow|string} input  Wallet row or wallet alias
 * @param {Object} [options]
 * @param {boolean} [options.requirePrivateKey=true]  When true, throws if no usable key is available.
 * @param {boolean} [options.verifyPubkey=true]       When true, verifies the signer address matches walletRow.pubkey.
 * @returns {Promise<Object>} Runtime wallet object suitable for swap/transaction code.
 */
async function getWalletForSwap(input, options) {
  const { requirePrivateKey = true, verifyPubkey = true } = options || {};

  let walletRow = input;

  // If a string is provided, treat it as an alias and resolve via the registry.
  if (typeof input === 'string') {
    const aliasOrAddress = input.trim();
    walletRow = await registry.getWalletByAlias(aliasOrAddress);
    if (!walletRow) {
      throw new Error(`No wallet found for alias "${aliasOrAddress}"`);
    }
  }

  if (!walletRow) {
    throw new Error('getWalletForSwap: wallet row is required');
  }

  const alias = walletRow.alias || '<unnamed-wallet>';

  // If we don't require a private key and there isn't one, return a view-only wallet
  if (!hasUsablePrivateKey(walletRow) && !requirePrivateKey) {
    return {
      walletId: walletRow.walletId !== undefined ? walletRow.walletId : walletRow.wallet_id,
      alias: walletRow.alias,
      pubkey: walletRow.pubkey,
      signer: null,
      hasPrivateKey: false,
      usageType: walletRow.usageType || walletRow.usage_type,
      strategyId: walletRow.strategyId || walletRow.strategy_id,
      raw: walletRow,
    };
  }

  // Resolve the private key string via secretProvider. This will throw if missing
  // when requirePrivateKey is true.
  const secretString = getPrivateKeyForWallet(walletRow, { requirePrivateKey });

  if (!secretString) {
    // If requirePrivateKey is false, secretString can be null -> view-only wallet.
    return {
      walletId: walletRow.walletId !== undefined ? walletRow.walletId : walletRow.wallet_id,
      alias: walletRow.alias,
      pubkey: walletRow.pubkey,
      signer: null,
      hasPrivateKey: false,
      usageType: walletRow.usageType || walletRow.usage_type,
      strategyId: walletRow.strategyId || walletRow.strategy_id,
      raw: walletRow,
    };
  }

  let keyBytes;
  const trimmed = secretString.trim();

  try {
    // We standardize on the Solana CLI id.json format here: a JSON array of 64 numbers.
    // This plays nicely with createKeyPairSignerFromBytes from @solana/kit.
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) {
        throw new Error('parsed value is not an array');
      }
      keyBytes = Uint8Array.from(arr);
    } else {
      // If the secret is not JSON, we could add support for other encodings later
      // (e.g. base58). For now, be explicit so misconfiguration fails loudly.
      throw new Error('secret is not in expected JSON array (id.json) format');
    }
  } catch (err) {
    throw new Error(
      `Failed to parse secret for wallet "${alias}": ${err && err.message ? err.message : err}`
    );
  }

  if (keyBytes.length !== 64) {
    throw new Error(
      `Secret for wallet "${alias}" has ${keyBytes.length} bytes; expected 64-byte Solana id.json keypair.`
    );
  }

  const signer = await createKeyPairSignerFromBytes(keyBytes);

  if (verifyPubkey && walletRow.pubkey) {
    const signerAddress = String(signer.address);
    if (signerAddress !== walletRow.pubkey) {
      throw new Error(
        `Signer address (${signerAddress}) does not match stored pubkey (${walletRow.pubkey}) for wallet "${alias}". ` +
          'Check that the env var / key_ref points to the correct keypair.'
      );
    }
  }

  return {
    walletId: walletRow.walletId !== undefined ? walletRow.walletId : walletRow.wallet_id,
    alias: walletRow.alias,
    pubkey: walletRow.pubkey,
    signer,
    hasPrivateKey: true,
    usageType: walletRow.usageType || walletRow.usage_type,
    strategyId: walletRow.strategyId || walletRow.strategy_id,
    raw: walletRow,
  };
}

module.exports = getWalletForSwap;