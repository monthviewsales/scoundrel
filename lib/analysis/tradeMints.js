'use strict';

// Known SOL mints to exclude when deriving token mints (WSOL and common aliases)
const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'sol', 'SOL', 'wSOL', 'WSOL'
]);

// Stablecoin mints to ignore when swapping out of SOL (profit-taking to stables)
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',  // USD1 (Solana variant)
]);

/** Tiny dot-path getter to avoid a lodash dep. */
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/** Return true if the given string looks like a base58 Solana mint address. */
function isBase58Mint(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/** @param {string} addr */
function isSolMint(addr) {
  return !!addr && (addr === 'So11111111111111111111111111111111111111112' || SOL_MINTS.has(addr));
}

/** @param {string} addr */
function isStableMint(addr) {
  return !!addr && STABLE_MINTS.has(addr);
}

/** Prefer a non-SOL candidate mint. */
function pickNonSolMint(a, b) {
  if (a && !SOL_MINTS.has(a)) return a;
  if (b && !SOL_MINTS.has(b)) return b;
  return a || b || null;
}

/**
 * Heuristic: treat SOL→stable swaps as profit-taking and skip in mint derivation.
 * @param {Object} trade
 * @returns {boolean}
 */
function isSolToStableSwap(trade) {
  const fromAddr = get(trade, 'from.address');
  const toAddr = get(trade, 'to.address');
  return isSolMint(fromAddr) && isStableMint(toAddr);
}

module.exports = {
  SOL_MINTS,
  STABLE_MINTS,
  isBase58Mint,
  isSolMint,
  isStableMint,
  pickNonSolMint,
  isSolToStableSwap,
};
