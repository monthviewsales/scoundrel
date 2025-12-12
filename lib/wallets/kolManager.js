'use strict';

const BootyBox = require('../../db');
const logger = require('../logger');

/**
 * Ensure an external wallet (usually from research/dossier) exists in the
 * registry as a KOL entry so it can be reused by future features.
 *
 * @param {Object} params
 * @param {string} params.walletAddress
 * @param {string} [params.alias]
 * @param {string|null} [params.color]
 */
async function ensureKolWallet({ walletAddress, alias, color = null }) {
  const trimmedAddress = typeof walletAddress === 'string' ? walletAddress.trim() : '';
  if (!trimmedAddress) return null;

  const safeAlias = alias ? String(alias).trim().slice(0, 64) : null;

  try {
    await BootyBox.init();
  } catch (err) {
    logger.warn(
      '[wallets] ensureKolWallet: BootyBox init failed; unable to persist KOL wallet:',
      err?.message || err
    );
    return null;
  }

  if (typeof BootyBox.upsertKolWalletFromDossier === 'function') {
    try {
      return BootyBox.upsertKolWalletFromDossier({
        wallet: trimmedAddress,
        traderName: safeAlias || trimmedAddress,
        color,
      });
    } catch (err) {
      logger.warn(
        '[wallets] upsertKolWalletFromDossier failed:',
        err?.message || err
      );
    }
  }

  if (typeof BootyBox.ensureKolWalletForProfile === 'function') {
    try {
      BootyBox.ensureKolWalletForProfile(trimmedAddress, safeAlias || trimmedAddress);
    } catch (err) {
      logger.warn(
        '[wallets] ensureKolWalletForProfile failed:',
        err?.message || err
      );
    }
  }

  return null;
}

module.exports = {
  ensureKolWallet,
};
