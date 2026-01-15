'use strict';

const BootyBox = require('../../../db');
const { ensureBootyBoxInit } = require('../../bootyBoxInit');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
const { normalizeQuery } = require('../formatting');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Check if a string looks like a base58 mint.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isBase58Mint(value) {
  return BASE58_RE.test(String(value || '').trim());
}

function normalizeTokenCandidate(item) {
  if (!item || typeof item !== 'object') return null;
  const token = item.token && typeof item.token === 'object' ? item.token : item;
  const mint =
    token.mint ||
    token.address ||
    token.tokenMint ||
    item.mint ||
    item.address ||
    null;
  if (!mint) return null;
  return {
    mint: String(mint),
    symbol: token.symbol || item.symbol || null,
    name: token.name || item.name || null,
  };
}

function dedupeByMint(rows) {
  const seen = new Set();
  return (rows || []).filter((row) => {
    if (!row || !row.mint) return false;
    const key = String(row.mint);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchMintsInDb(query) {
  await ensureBootyBoxInit();
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  if (isBase58Mint(trimmed) && typeof BootyBox.getCoinByMint === 'function') {
    const coin = await BootyBox.getCoinByMint(trimmed);
    if (coin && coin.mint) {
      return [
        {
          mint: coin.mint,
          symbol: coin.symbol || null,
          name: coin.name || null,
        },
      ];
    }
  }

  if (typeof BootyBox.listCoins !== 'function') return [];

  const normalized = normalizeQuery(trimmed);
  const coins = await BootyBox.listCoins();
  const matches = coins.filter((coin) => {
    if (!coin) return false;
    const symbol = normalizeQuery(coin.symbol);
    const name = normalizeQuery(coin.name);
    return (
      (symbol && (symbol === normalized || symbol.startsWith(normalized))) ||
      (name && (name === normalized || name.startsWith(normalized)))
    );
  });

  return matches.map((coin) => ({
    mint: coin.mint,
    symbol: coin.symbol || null,
    name: coin.name || null,
  }));
}

async function searchMintsViaApi(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  if (trimmed.length < 4) return [];

  let client;
  try {
    client = createSolanaTrackerDataClient();
  } catch (_) {
    return [];
  }
  if (!client || typeof client.searchTokens !== 'function') return [];

  try {
    const response = await client.searchTokens({ query: trimmed });
    const rows = Array.isArray(response)
      ? response
      : Array.isArray(response?.tokens)
        ? response.tokens
        : Array.isArray(response?.data)
          ? response.data
          : [];
    return dedupeByMint(rows.map(normalizeTokenCandidate).filter(Boolean));
  } catch (_) {
    return [];
  }
}

/**
 * Resolve mint candidates from DB first, then API fallback.
 *
 * @param {string} query
 * @returns {Promise<{ matches: object[], source: string }>}
 */
async function resolveMintCandidates(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { matches: [], source: 'none' };

  const dbMatches = await searchMintsInDb(trimmed);
  if (dbMatches.length) return { matches: dedupeByMint(dbMatches), source: 'db' };

  const apiMatches = await searchMintsViaApi(trimmed);
  if (apiMatches.length) return { matches: apiMatches, source: 'api' };

  return { matches: [], source: 'none' };
}

module.exports = {
  isBase58Mint,
  resolveMintCandidates,
};
