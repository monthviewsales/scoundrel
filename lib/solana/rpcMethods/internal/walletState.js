

'use strict';

// Centralized live wallet state shared across HUD, daemon, and any workers.
// Mirrors chainState pattern: simple singleton object with update helpers.
//
// Structure:
// walletState[pubkey] = {
//   solLamports: number,     // latest lamports value
//   solLastUpdated: number,  // timestamp
//   tokens: {
//     [mint]: {
//       amount: number,      // raw token amount (not decimals-adjusted)
//       decimals: number | null,
//       symbol: string | null,
//       priceUsd: number | null,
//       lastUpdated: number,
//     }
//   },
//   lastActivity: number | null,
// };

const walletState = Object.create(null);

function ensureWallet(pubkey) {
  if (!walletState[pubkey]) {
    walletState[pubkey] = {
      solLamports: 0,
      solLastUpdated: null,
      tokens: Object.create(null),
      lastActivity: null,
    };
  }
  return walletState[pubkey];
}

/** Update SOL lamports for a wallet (WS or HTTP). */
function updateSol(pubkey, lamports) {
  const w = ensureWallet(pubkey);
  const now = Date.now();
  try {
    const n = typeof lamports === 'bigint' ? Number(lamports) : Number(lamports);
    if (!Number.isFinite(n)) return;
    w.solLamports = n;
    w.solLastUpdated = now;
    w.lastActivity = now;
  } catch (_) {
    // swallow conversion errors; caller can decide if they want to log
  }
}

/** Update a token's raw amount + optional metadata. */
function updateToken(pubkey, mint, { amount, decimals = null, symbol = null, priceUsd = null } = {}) {
  const w = ensureWallet(pubkey);
  if (!w.tokens[mint]) {
    w.tokens[mint] = {
      amount: 0,
      decimals: null,
      symbol: null,
      priceUsd: null,
      lastUpdated: null,
    };
  }

  const t = w.tokens[mint];
  const now = Date.now();

  if (amount != null) {
    try {
      const n = typeof amount === 'bigint' ? Number(amount) : Number(amount);
      if (Number.isFinite(n)) t.amount = n;
    } catch (_) {}
  }

  if (decimals != null) t.decimals = decimals;
  if (symbol != null) t.symbol = symbol;
  if (priceUsd != null) t.priceUsd = priceUsd;

  t.lastUpdated = now;
  w.lastActivity = now;
}

function getWalletState(pubkey) {
  return walletState[pubkey] || null;
}

module.exports = {
  ensureWallet,
  updateSol,
  updateToken,
  getWalletState,
  walletState,
};