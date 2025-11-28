'use strict';

/**
 * Parsed swap deltas for a single wallet/mint within a transaction.
 *
 * This is intentionally generic and protocol-agnostic: it relies only on the
 * standard Solana getTransaction meta fields (pre/post balances and
 * pre/post token balances). It does **not** attempt to decode any specific
 * AMM, router or aggregator programs.
 *
 * @typedef {Object} ParsedSwap
 * @property {string} mint - SPL mint address for the tracked token.
 * @property {string} payerPubkey - Wallet pubkey we are measuring deltas for.
 * @property {number} tokenDelta - Net token amount **gained** by the wallet
 *   (postTokenBalance - preTokenBalance). Typically positive for buys.
 * @property {number} tokenDecrease - Net token amount **lost** by the wallet
 *   (preTokenBalance - postTokenBalance). Typically positive for sells.
 * @property {number} solDiff - Net SOL change for the wallet (post - pre), in SOL.
 *   Negative means SOL was spent, positive means SOL was received.
 * @property {number|null} solDiffLamports - Net SOL change in lamports, or null
 *   if it could not be computed.
 * @property {number|null} feeLamports - Network fee in lamports, if available.
 * @property {number|null} slot - Slot the transaction was processed in, if available.
 * @property {Object|undefined} [tokenInfo] - Optional token metadata (e.g. symbol, name,
 *   decimals, priceUsd) when enrichment is used.
 */

const fs = require('fs');
const path = require('path');

let tokenInfoService = null;
try {
  // Optional dependency: token metadata enrichment for swap parsing.
  // eslint-disable-next-line global-require
  tokenInfoService = require('../services/tokenInfoService');
} catch (err) {
  tokenInfoService = null;
}

function toBigIntOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      return BigInt(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function normalizePubkeyLike(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const s = value.trim();
    return s.length ? s : null;
  }

  if (typeof value === 'number') {
    // Not a pubkey; numeric indices are handled separately.
    return null;
  }

  if (typeof value === 'object') {
    // PublicKey-like with toBase58()
    if (typeof value.toBase58 === 'function') {
      const s = value.toBase58();
      return typeof s === 'string' && s.length ? s : null;
    }

    // Generic toString() that actually returns base58
    if (typeof value.toString === 'function') {
      const s = value.toString();
      if (typeof s === 'string' && s.length && s !== '[object Object]') {
        return s;
      }
    }

    // Some clients nest under .pubkey
    if (value.pubkey) {
      const nested = normalizePubkeyLike(value.pubkey);
      if (nested) return nested;
    }
  }

  return null;
}

function isSaveRawEnabled() {
  const v = process.env.SAVE_RAW;
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function jsonSafeStringify(value) {
  return JSON.stringify(
    value,
    (key, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}

function maybeWriteSwapDebugArtifact(rawTx, parsedSwap, context) {
  if (!isSaveRawEnabled()) return;

  const payload = {
    timestamp: new Date().toISOString(),
    context: {
      mint: context && context.mint,
      payerPubkey: context && context.payerPubkey,
      signature: context && context.signature,
    },
    rawTx,
    parsedSwap,
  };

  try {
    const walletDir = (context && context.payerPubkey) ? context.payerPubkey : 'unknown-wallet';
    const mintPart = (context && context.mint) ? context.mint : 'unknown-mint';
    const baseDir = path.join(
      process.cwd(),
      'data',
      'parseSwapTx',
      walletDir,
    );
    fs.mkdirSync(baseDir, { recursive: true });
    const filename = path.join(
      baseDir,
      `${mintPart}-${Date.now()}.json`,
    );
    fs.writeFileSync(filename, jsonSafeStringify(payload), 'utf8');
  } catch (err) {
    // Best-effort only: never let artifact writing break swap parsing.
  }
}

/**
 * Extract a numeric token balance from a token balance descriptor.
 *
 * Prefers uiTokenAmount.uiAmount when present, and falls back to
 * amount/decimals when necessary.
 *
 * @param {Object} balance
 * @returns {number}
 * @private
 */
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

/**
 * Aggregate pre/post token balances for a given wallet + mint.
 *
 * @param {Object[]} balances
 * @param {string} mint
 * @param {string} owner
 * @returns {number}
 * @private
 */
function sumTokenBalancesForOwner(balances, mint, owner, accountKeys) {
  if (!Array.isArray(balances) || !mint || !owner) return 0;

  const focusOwner = owner.trim();
  let total = 0;

  for (let i = 0; i < balances.length; i += 1) {
    const b = balances[i];
    if (!b || b.mint !== mint) continue;

    let balanceOwner = null;

    // Prefer explicit owner field when present
    if (Object.prototype.hasOwnProperty.call(b, 'owner')) {
      balanceOwner = normalizePubkeyLike(b.owner);
    }

    // Fallback to accountIndex mapped via accountKeys
    if (!balanceOwner && typeof b.accountIndex === 'number' && Array.isArray(accountKeys)) {
      const idx = b.accountIndex;
      if (idx >= 0 && idx < accountKeys.length) {
        balanceOwner = normalizePubkeyLike(accountKeys[idx]);
      }
    }

    if (!balanceOwner || balanceOwner !== focusOwner) continue;

    const val = extractUiTokenAmount(b);
    if (Number.isFinite(val)) {
      total += val;
    }
  }

  return total;
}

/**
 * Parse swap deltas (token + SOL) for a given wallet and mint from a raw
 * getTransaction response value.
 *
 * This expects the "raw" value from Solana's getTransaction RPC, i.e. the
 * object that contains { slot, meta, transaction, blockTime }. It does not
 * rely on any Scoundrel-specific normalization beyond that.
 *
 * @param {Object} rawTx - Raw getTransaction value (not the outer JSON-RPC envelope).
 * @param {Object} opts
 * @param {string} opts.mint - SPL mint address to track.
 * @param {string} opts.payerPubkey - Wallet pubkey whose balances we care about.
 * @returns {ParsedSwap|null} - Parsed swap deltas, or null if the transaction
 *   does not appear to affect the given wallet/mint.
 */
function parseSwapFromTransaction(rawTx, opts) {
  if (!rawTx || typeof rawTx !== 'object') return null;
  const { mint, payerPubkey } = opts || {};
  if (!mint || !payerPubkey) return null;

  const { meta, transaction, slot } = rawTx;
  if (!meta || !transaction || !transaction.message) return null;

  const { message } = transaction;
  const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];

  // --- Token deltas (for the specific mint + owner) ---
  const preTokenBalances = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const postTokenBalances = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];

  const preToken = sumTokenBalancesForOwner(preTokenBalances, mint, payerPubkey, accountKeys);
  const postToken = sumTokenBalancesForOwner(postTokenBalances, mint, payerPubkey, accountKeys);

  let tokenDelta = 0;
  let tokenDecrease = 0;
  const diffToken = postToken - preToken;
  if (diffToken > 0) {
    tokenDelta = diffToken;
  } else if (diffToken < 0) {
    tokenDecrease = -diffToken;
  }

  // --- SOL delta for the payer ---
  let solDiffLamports = null;
  let solDiff = 0;

  const preBalances = Array.isArray(meta.preBalances) ? meta.preBalances : [];
  const postBalances = Array.isArray(meta.postBalances) ? meta.postBalances : [];

  if (preBalances.length === postBalances.length && accountKeys.length === preBalances.length) {
    const focusWallet = payerPubkey.trim();
    let payerIndex = -1;
    for (let i = 0; i < accountKeys.length; i += 1) {
      const normalized = normalizePubkeyLike(accountKeys[i]);
      if (normalized === focusWallet) {
        payerIndex = i;
        break;
      }
    }

    if (payerIndex >= 0) {
      const pre = toBigIntOrNull(preBalances[payerIndex]);
      const post = toBigIntOrNull(postBalances[payerIndex]);
      if (pre !== null && post !== null) {
        const lamportsDelta = post - pre; // positive = gained, negative = spent
        const asNumber = Number(lamportsDelta);
        if (Number.isFinite(asNumber)) {
          solDiffLamports = asNumber;
          solDiff = asNumber / 1_000_000_000;
        } else {
          solDiffLamports = null;
          solDiff = 0;
        }
      }
    }
  }

  // --- Network fee ---
  let feeLamports = null;
  if (Object.prototype.hasOwnProperty.call(meta, 'fee')) {
    const rawFee = meta.fee;
    const feeBig = toBigIntOrNull(rawFee);
    if (feeBig !== null) {
      const n = Number(feeBig);
      if (Number.isFinite(n)) {
        feeLamports = n;
      }
    }
  }

  // If nothing meaningful changed for this wallet/mint, callers may treat the
  // transaction as "not a swap for this context". We still emit an artifact
  // when SAVE_RAW=true so we can debug token/owner shapes.
  const hasTokenChange = tokenDelta !== 0 || tokenDecrease !== 0;
  const hasSolChange = solDiffLamports !== null && solDiffLamports !== 0;

  const parsed = {
    mint,
    payerPubkey,
    tokenDelta,
    tokenDecrease,
    solDiff,
    solDiffLamports,
    feeLamports,
    slot: typeof slot === 'number' ? slot : (typeof slot === 'bigint' ? Number(slot) : null),
  };

  // Best-effort debug artifact for this tx context when requested.
  maybeWriteSwapDebugArtifact(rawTx, parsed, { mint, payerPubkey });

  if (!hasTokenChange && !hasSolChange && feeLamports == null) {
    return null;
  }

  return parsed;
}

/**
 * Async helper that wraps parseSwapFromTransaction and enriches the result with
 * token metadata from tokenInfoService when available.
 *
 * This keeps the core parser synchronous and side-effect-free, while allowing
 * higher-level callers (CLI, services) to opt into DB/API-backed token details
 * without coupling inspectTransaction to BootyBox.
 *
 * @param {Object} rawTx - Raw getTransaction value.
 * @param {Object} opts - Same options as parseSwapFromTransaction.
 * @returns {Promise<ParsedSwap|null>} Parsed and optionally enriched swap.
 */
async function parseSwapFromTransactionWithTokenInfo(rawTx, opts) {
  const base = parseSwapFromTransaction(rawTx, opts);
  if (!base) return null;

  const mint = base.mint;
  let tokenInfo = null;

  try {
    // Prefer an ensure+get flow if both are present, but tolerate different signatures.
    if (typeof tokenInfoService.ensureTokenInfo === 'function') {
      try {
        // Common pattern: ensureTokenInfo({ mint })
        await tokenInfoService.ensureTokenInfo({ mint });
      } catch (innerErr) {
        // Fallback: ensureTokenInfo(mint)
        await tokenInfoService.ensureTokenInfo(mint);
      }
    }

    if (typeof tokenInfoService.getTokenInfo === 'function') {
      // First attempt: getTokenInfo({ mint })
      try {
        tokenInfo = await tokenInfoService.getTokenInfo({ mint });
      } catch (innerErr) {
        tokenInfo = null;
      }

      // If that did not yield a result, try getTokenInfo(mint).
      if (!tokenInfo) {
        try {
          tokenInfo = await tokenInfoService.getTokenInfo(mint);
        } catch (innerErr) {
          tokenInfo = null;
        }
      }
    }
  } catch (err) {
    // Enrichment is best-effort only; never break swap parsing.
    tokenInfo = null;
  }

  if (!tokenInfo) {
    return base;
  }

  return {
    ...base,
    tokenInfo,
  };
}

module.exports = {
  parseSwapFromTransaction,
  parseSwapFromTransactionWithTokenInfo,
};
