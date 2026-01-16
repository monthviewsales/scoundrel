'use strict';

const { normalizePubkeyLike } = require('./transactionAccounts');

function extractUiTokenAmount(balance) {
  if (!balance || typeof balance !== 'object') return 0;
  const ui = balance.uiTokenAmount || balance.tokenAmount || {};

  if (typeof ui.uiAmount === 'number') {
    return ui.uiAmount;
  }

  if (typeof ui.uiAmountString === 'string') {
    const n = Number(ui.uiAmountString);
    return Number.isFinite(n) ? n : 0;
  }

  if (typeof ui.amount === 'string' && typeof ui.decimals === 'number') {
    const raw = Number(ui.amount);
    if (!Number.isFinite(raw)) return 0;
    return raw / (10 ** ui.decimals);
  }

  return 0;
}

function resolveTokenOwner(entry, accountKeys) {
  if (!entry) return null;
  if (entry.owner) return normalizePubkeyLike(entry.owner);
  const idx = entry.accountIndex;
  if (
    typeof idx === 'number' &&
    Array.isArray(accountKeys) &&
    idx >= 0 &&
    idx < accountKeys.length
  ) {
    return normalizePubkeyLike(accountKeys[idx]);
  }
  return null;
}

function addTokenTotal(map, owner, mint, amount) {
  if (!owner || !mint) return;
  if (!map.has(owner)) map.set(owner, new Map());
  const ownerMap = map.get(owner);
  ownerMap.set(mint, (ownerMap.get(mint) || 0) + amount);
}

function collectTokenTotals(balances, accountKeys, decimalsByMint) {
  const totalsByOwner = new Map();
  if (!Array.isArray(balances)) return totalsByOwner;

  for (const entry of balances) {
    if (!entry || !entry.mint) continue;
    const owner = resolveTokenOwner(entry, accountKeys);
    if (!owner) continue;
    const amount = extractUiTokenAmount(entry);
    if (!Number.isFinite(amount)) continue;
    addTokenTotal(totalsByOwner, owner, entry.mint, amount);
    const decimals = Number(entry.uiTokenAmount?.decimals ?? entry.tokenAmount?.decimals ?? 0);
    if (Number.isFinite(decimals) && !decimalsByMint.has(entry.mint)) {
      decimalsByMint.set(entry.mint, decimals);
    }
  }

  return totalsByOwner;
}

/**
 * Compute token balance deltas grouped by owner/mint.
 *
 * @param {Object|null} meta
 * @param {string[]} accountKeys
 * @returns {{ deltasByOwner: Map<string, Map<string, number>>, decimalsByMint: Map<string, number> }}
 */
function computeTokenDeltasByOwner(meta, accountKeys) {
  const deltasByOwner = new Map();
  const decimalsByMint = new Map();

  if (!meta) {
    return { deltasByOwner, decimalsByMint };
  }

  const preTotals = collectTokenTotals(meta.preTokenBalances, accountKeys, decimalsByMint);
  const postTotals = collectTokenTotals(meta.postTokenBalances, accountKeys, decimalsByMint);

  const owners = new Set([...preTotals.keys(), ...postTotals.keys()]);
  for (const owner of owners) {
    const preMap = preTotals.get(owner) || new Map();
    const postMap = postTotals.get(owner) || new Map();
    const mints = new Set([...preMap.keys(), ...postMap.keys()]);
    if (!mints.size) continue;
    const ownerDeltas = new Map();
    for (const mint of mints) {
      const preVal = preMap.get(mint) || 0;
      const postVal = postMap.get(mint) || 0;
      const delta = postVal - preVal;
      if (!Number.isFinite(delta) || delta === 0) continue;
      ownerDeltas.set(mint, delta);
    }
    if (ownerDeltas.size) {
      deltasByOwner.set(owner, ownerDeltas);
    }
  }

  return { deltasByOwner, decimalsByMint };
}

/**
 * Compute token balance deltas for a specific owner.
 *
 * @param {Object|null} meta
 * @param {string[]} accountKeys
 * @param {string} owner
 * @returns {{ deltasByMint: Map<string, number>, decimalsByMint: Map<string, number> }}
 */
function computeTokenDeltasForOwner(meta, accountKeys, owner) {
  const normalizedOwner = normalizePubkeyLike(owner);
  if (!normalizedOwner) {
    return { deltasByMint: new Map(), decimalsByMint: new Map() };
  }
  const { deltasByOwner, decimalsByMint } = computeTokenDeltasByOwner(meta, accountKeys);
  return {
    deltasByMint: deltasByOwner.get(normalizedOwner) || new Map(),
    decimalsByMint,
  };
}

/**
 * Compute per-account SOL balance changes from pre/post balances.
 *
 * @param {Object|null} meta
 * @param {string[]} accountKeys
 * @returns {Array<{ owner: string, preLamports: number, postLamports: number, deltaLamports: number, deltaSol: number }>}
 */
function computeSolChanges(meta, accountKeys) {
  if (
    !meta ||
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    !Array.isArray(accountKeys)
  ) {
    return [];
  }

  const pre = meta.preBalances;
  const post = meta.postBalances;
  const len = Math.min(pre.length, post.length, accountKeys.length);
  const results = [];

  for (let i = 0; i < len; i += 1) {
    let preLamports = pre[i];
    let postLamports = post[i];
    try {
      preLamports = typeof preLamports === 'number' ? preLamports : Number(preLamports || 0);
      postLamports = typeof postLamports === 'number' ? postLamports : Number(postLamports || 0);
    } catch (_) {
      // eslint-disable-next-line no-continue
      continue;
    }

    if (!Number.isFinite(preLamports) || !Number.isFinite(postLamports)) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const deltaLamports = postLamports - preLamports;
    if (deltaLamports === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const owner = accountKeys[i];
    results.push({
      owner,
      preLamports,
      postLamports,
      deltaLamports,
      deltaSol: deltaLamports / 1_000_000_000,
    });
  }

  return results;
}

/**
 * Compute SOL delta for a specific owner based on pre/post balances.
 *
 * @param {Object|null} meta
 * @param {string[]} accountKeys
 * @param {string} owner
 * @returns {{ deltaLamports: number|null, deltaSol: number|null }}
 */
function computeSolDeltaForOwner(meta, accountKeys, owner) {
  if (!meta || !Array.isArray(accountKeys)) {
    return { deltaLamports: null, deltaSol: null };
  }
  const normalizedOwner = normalizePubkeyLike(owner);
  if (!normalizedOwner) {
    return { deltaLamports: null, deltaSol: null };
  }

  const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [];
  const post = Array.isArray(meta.postBalances) ? meta.postBalances : [];

  const idx = accountKeys.findIndex((key) => key === normalizedOwner);
  if (idx < 0 || idx >= pre.length || idx >= post.length) {
    return { deltaLamports: null, deltaSol: null };
  }

  const preLamports = Number(pre[idx]);
  const postLamports = Number(post[idx]);
  if (!Number.isFinite(preLamports) || !Number.isFinite(postLamports)) {
    return { deltaLamports: null, deltaSol: null };
  }

  const deltaLamports = postLamports - preLamports;
  return {
    deltaLamports,
    deltaSol: deltaLamports / 1_000_000_000,
  };
}

module.exports = {
  computeTokenDeltasByOwner,
  computeTokenDeltasForOwner,
  computeSolChanges,
  computeSolDeltaForOwner,
};
