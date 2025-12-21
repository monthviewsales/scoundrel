

// Centralized stablecoin mint registry.
// Keep this as the single source of truth for “is this mint stable?” logic.

// Mainnet stablecoin mints (Solana SPL token addresses)
// NOTE: Add/remove here only; consumers should import `isStableMint`.
const STABLE_MINT_LIST = [
  // USDC
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // USDT
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  // USD1 (project-specific)
  'USD1ttGY1N17FiQhWdKqenNXy3Hf3fChVhYbqDS9n9w',
];

const STABLE_MINTS = new Set(STABLE_MINT_LIST);

function normalizeMint(mint) {
  if (!mint) return null;
  if (typeof mint === 'string') return mint.trim();
  // Support PublicKey-like objects
  if (typeof mint?.toBase58 === 'function') return String(mint.toBase58());
  if (typeof mint?.toString === 'function') return String(mint.toString());
  return null;
}

function isStableMint(mint) {
  const key = normalizeMint(mint);
  if (!key) return false;
  return STABLE_MINTS.has(key);
}

module.exports = {
  STABLE_MINT_LIST,
  STABLE_MINTS,
  normalizeMint,
  isStableMint,
};