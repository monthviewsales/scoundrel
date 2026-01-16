'use strict';

const walletRegistry = require('../../wallets/walletRegistry');
const { isBase58Pubkey } = require('../../wallets/walletSelection');
const { normalizeQuery } = require('../formatting');

function byAlias(a, b) {
  if (!a || !b) return 0;
  return String(a.alias || '').localeCompare(String(b.alias || ''));
}

/**
 * Load wallet records and optionally filter by query.
 *
 * @param {string} [query]
 * @returns {Promise<object[]>}
 */
async function loadWalletMatches(query) {
  const wallets = await walletRegistry.getAllWallets();
  if (!query) return wallets.sort(byAlias);

  const trimmed = String(query).trim();
  if (!trimmed) return wallets.sort(byAlias);

  const normalized = normalizeQuery(trimmed);
  const isPubkey = isBase58Pubkey(trimmed);

  const matches = wallets.filter((wallet) => {
    if (!wallet) return false;
    if (isPubkey) {
      return wallet.pubkey === trimmed || String(wallet.pubkey).startsWith(trimmed);
    }
    const alias = normalizeQuery(wallet.alias);
    return alias === normalized || alias.startsWith(normalized);
  });

  if (matches.length) return matches.sort(byAlias);
  return wallets.sort(byAlias);
}

module.exports = {
  loadWalletMatches,
};
