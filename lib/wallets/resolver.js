'use strict';

const logger = require('../logger');
const { resolveWalletSpecsWithRegistry } = require('../warchest/walletResolver');
const registry = require('./registry');

function isBase58Address(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/**
 * Create a wallet resolver that can map aliases or addresses to registry records
 * and provide sensible fallbacks for watch-only inputs.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.registry] - Custom registry (defaults to lib/wallets/registry.js)
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
    if (isBase58Address(raw)) {
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
          strategyId: null,
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
};
