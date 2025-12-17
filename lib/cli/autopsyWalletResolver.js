'use strict';

const { createWalletResolver } = require('../wallets/resolver');

/**
 * Resolve autopsy wallet inputs to a registry-backed address and label.
 *
 * @param {Object} params
 * @param {string} [params.walletLabel] Optional caller-provided label or alias.
 * @param {string} [params.walletAddress] Wallet alias or address.
 * @param {Object} [params.resolver] Optional wallet resolver (defaults to registry-backed resolver).
 * @returns {Promise<{walletLabel: string, walletAddress: string}>}
 */
async function resolveAutopsyWallet({ walletLabel, walletAddress, resolver } = {}) {
  const resolverInput = walletAddress || walletLabel || '';
  const walletResolver = resolver || createWalletResolver();
  const resolved = await walletResolver.resolveAliasOrAddress(resolverInput);

  if (!resolved || !resolved.wallet || !resolved.wallet.pubkey) {
    throw new Error(`[autopsy] Unable to resolve wallet from input: ${resolverInput}`);
  }

  const resolvedWalletAddress = resolved.wallet.pubkey;
  const resolvedWalletLabel = walletLabel || resolved.wallet.alias || resolvedWalletAddress;

  return {
    walletLabel: resolvedWalletLabel,
    walletAddress: resolvedWalletAddress,
  };
}

module.exports = { resolveAutopsyWallet };
