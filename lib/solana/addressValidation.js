'use strict';

let addresses;
try {
  addresses = require('@solana/addresses');
} catch (_) {
  addresses = null;
}

const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Normalize an address-like input into a trimmed string.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAddressInput(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Return true if the value is address-shaped (length 32-44 chars).
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeSolanaAddress(value) {
  const trimmed = normalizeAddressInput(value);
  if (!trimmed) return false;
  return trimmed.length >= 32 && trimmed.length <= 44;
}

/**
 * Build a consistent invalid-address message.
 *
 * @param {string} value
 * @param {string} [label]
 * @returns {string}
 */
function buildInvalidAddressMessage(value, label) {
  const kind = label ? String(label) : 'address';
  const trimmed = normalizeAddressInput(value);
  return trimmed
    ? `Invalid ${kind} detected: ${trimmed}`
    : `Invalid ${kind} detected`;
}

/**
 * Create a consistent invalid-address error.
 *
 * @param {string} value
 * @param {string} [label]
 * @returns {Error}
 */
function createInvalidAddressError(value, label) {
  return new Error(buildInvalidAddressMessage(value, label));
}

/**
 * Check whether a string is a valid Solana base58 address.
 * Uses @solana/addresses when available, with a regex fallback.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSolanaAddress(value) {
  const trimmed = normalizeAddressInput(value);
  if (!trimmed) return false;

  if (addresses && typeof addresses.isAddress === 'function') {
    try {
      return addresses.isAddress(trimmed);
    } catch (_) {
      return false;
    }
  }

  return BASE58_ADDRESS_RE.test(trimmed);
}

/**
 * Assert that a string is a valid Solana address.
 *
 * @param {string} value
 * @param {string} [label]
 * @returns {string}
 * @throws {Error} when the address is invalid
 */
function assertSolanaAddress(value, label) {
  const trimmed = normalizeAddressInput(value);
  if (!isSolanaAddress(trimmed)) {
    throw createInvalidAddressError(trimmed || value, label);
  }
  return trimmed;
}

/**
 * Check if a mint address is valid.
 *
 * @param {string} mint
 * @returns {boolean}
 */
function isValidMintAddress(mint) {
  return isSolanaAddress(mint);
}

/**
 * Check if a wallet address is valid.
 *
 * @param {string} wallet
 * @returns {boolean}
 */
function isValidWalletAddress(wallet) {
  return isSolanaAddress(wallet);
}

/**
 * Assert that a mint address is valid.
 *
 * @param {string} mint
 * @returns {string}
 * @throws {Error} when the mint is invalid
 */
function assertValidMintAddress(mint) {
  return assertSolanaAddress(mint, 'mint');
}

/**
 * Assert that a wallet address is valid.
 *
 * @param {string} wallet
 * @returns {string}
 * @throws {Error} when the wallet is invalid
 */
function assertValidWalletAddress(wallet) {
  return assertSolanaAddress(wallet, 'wallet');
}

module.exports = {
  buildInvalidAddressMessage,
  createInvalidAddressError,
  assertSolanaAddress,
  assertValidMintAddress,
  assertValidWalletAddress,
  isSolanaAddress,
  isValidMintAddress,
  isValidWalletAddress,
  looksLikeSolanaAddress,
};
