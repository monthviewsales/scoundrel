'use strict';

/**
 * Resolve a wallet alias or address into signing material for swaps.
 *
 * TODO: Implement when swap abilities are finalized (future project).
 * Wallet keys are sensitive; ensure any implementation stores and loads
 * secrets securely (no plaintext at rest, avoid logging keys).
 *
 * @param {string} aliasOrAddress - Wallet alias from the registry or a base58 pubkey.
 * @returns {Promise<{ pubkey: string, keypair: any }>} Resolves to signing details.
 * @throws {Error} Always until the swap flow is completed.
 */
module.exports = async function getWalletForSwap(aliasOrAddress) {
  const reason = '[getWalletForSwap] TODO: implement swap wallet resolution after swap flow is finalized';
  throw new Error(reason);
};
