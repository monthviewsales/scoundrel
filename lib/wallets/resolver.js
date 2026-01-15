'use strict';

const logger = require('../logger');
const registry = require('./walletRegistry');
const { isValidWalletAddress } = require('../solana/addressValidation');

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

/**
 * Create a wallet resolver that can map aliases or addresses to registry records
 * and provide sensible fallbacks for watch-only inputs.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.registry] - Custom registry (defaults to lib/wallets/walletRegistry.js)
 * @param {Object} [deps.log] - Optional logger (defaults to lib/logger)
 * @returns {Object} resolver API
 */
function createWalletResolver(deps = {}) {
  const reg = deps.registry || registry;
  const log = deps.log || logger;

  async function getAllWallets() {
    return reg.getAllWallets();
  }

  async function getWalletByAlias(alias) {
    if (!alias) return null;
    return reg.getWalletByAlias(alias);
  }

  async function findWalletByPubkey(pubkey) {
    if (!pubkey) return null;
    const wallets = await reg.getAllWallets();
    return (wallets || []).find((w) => w && w.pubkey === pubkey) || null;
  }

  async function resolveAliasOrAddress(input) {
    const raw = input && typeof input === 'string' ? input.trim() : '';
    if (!raw) return null;

    // 1) Try alias
    const byAlias = await getWalletByAlias(raw);
    if (byAlias) {
      return { source: 'registry:alias', wallet: byAlias };
    }

    // 2) If looks like base58, try pubkey match
    if (isValidWalletAddress(raw)) {
      const byPubkey = await findWalletByPubkey(raw);
      if (byPubkey) {
        return { source: 'registry:pubkey', wallet: byPubkey };
      }
      // 3) Not in registry; treat as watch-only passthrough
      return {
        source: 'passthrough',
        wallet: {
          alias: null,
          pubkey: raw,
          color: null,
          usageType: 'other',
          hasPrivateKey: false,
          keySource: 'none',
          keyRef: null,
          isDefaultFunding: false,
          autoAttachWarchest: false,
          strategy: null,
        },
      };
    }

    // Not base58 and not an alias match
    log && log.warn && log.warn('[walletResolver] unable to resolve wallet input:', raw);
    return null;
  }

  async function listFundingWallets() {
    return reg.listFundingWallets();
  }

  async function getDefaultFundingWallet() {
    return reg.getDefaultFundingWallet();
  }

  async function listAutoAttachedWarchestWallets() {
    return reg.listAutoAttachedWarchestWallets();
  }

  async function listWalletsByUsage(usageType) {
    return reg.listWalletsByUsage(usageType);
  }

  return {
    getAllWallets,
    getWalletByAlias,
    findWalletByPubkey,
    resolveAliasOrAddress,
    listFundingWallets,
    getDefaultFundingWallet,
    listAutoAttachedWarchestWallets,
    listWalletsByUsage,
    resolveWalletSpecsWithRegistry,
  };
}

module.exports = {
  createWalletResolver,
  resolveWalletSpecsWithRegistry,
};
