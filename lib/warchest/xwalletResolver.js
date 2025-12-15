'use strict';

const logger = require('../logger');

/**
 * @typedef {Object} WalletSpec
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} [color]
 */

/**
 * Resolve CLI-provided wallet specs against the BootyBox registry, inserting
 * rows when necessary so downstream trade persistence uses canonical wallet IDs.
 *
 * @param {WalletSpec[]} walletSpecs
 * @param {object} bootyBox - BootyBox adapter with wallet helpers.
 * @returns {Promise<Array<{alias: string, pubkey: string, color: string|null, walletId: number}>>}
 */
async function resolveWalletSpecsWithRegistry(walletSpecs, bootyBox) {
  if (!Array.isArray(walletSpecs)) return [];
  if (!bootyBox) {
    throw new Error('resolveWalletSpecsWithRegistry: bootyBox adapter is required');
  }

  const resolved = [];

  for (const spec of walletSpecs) {
    if (!spec || !spec.alias || !spec.pubkey) {
      continue;
    }

    try {
      const existing =
        typeof bootyBox.getWarchestWalletByAlias === 'function'
          ? bootyBox.getWarchestWalletByAlias(spec.alias)
          : null;

      if (existing && existing.pubkey && existing.pubkey !== spec.pubkey) {
        logger.error(
          `[HUD] Wallet alias ${spec.alias} maps to pubkey ${existing.pubkey} in DB but CLI provided ${spec.pubkey}; skipping persistence for this wallet to avoid mis-attribution.`,
        );
        continue;
      }

      let record = existing;
      if (!record) {
        if (typeof bootyBox.insertWarchestWallet !== 'function') {
          throw new Error('resolveWalletSpecsWithRegistry: insertWarchestWallet is unavailable');
        }

        record = bootyBox.insertWarchestWallet({
          alias: spec.alias,
          pubkey: spec.pubkey,
          usageType: 'funding',
          autoAttachWarchest: true,
          color: spec.color || null,
        });
      } else if (!record.color && spec.color && typeof bootyBox.updateWarchestWalletColor === 'function') {
        // Fill in DB color when the registry lacks one but CLI provided it.
        bootyBox.updateWarchestWalletColor(spec.alias, spec.color);
        record = { ...record, color: spec.color };
      }

      resolved.push({
        alias: spec.alias,
        pubkey: spec.pubkey,
        color: spec.color || record.color || null,
        walletId: record.walletId,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.error(`[HUD] Failed to resolve wallet ${spec.alias}: ${msg}`);
    }
  }

  return resolved;
}

module.exports = {
  resolveWalletSpecsWithRegistry,
};
