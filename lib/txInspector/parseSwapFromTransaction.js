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
const path = require('path');
const {
  formatRunId,
  getArtifactConfig,
  sanitizeSegment,
  writeJsonArtifact,
} = require('../persist/jsonArtifacts');
const { resolveTransactionAccountKeys } = require('../solana/transactionAccounts');
const {
  computeSolDeltaForOwner,
  computeTokenDeltasForOwner,
} = require('../solana/transactionDeltas');

const { saveRaw: SAVE_RAW } = getArtifactConfig();
const ARTIFACT_BASE_DIR = path.join(process.cwd(), 'data');

let tokenInfoService = null;
try {
  // Optional dependency: token metadata enrichment for swap parsing.
  // eslint-disable-next-line global-require
  tokenInfoService = require('../services/tokenInfoService');
} catch (err) {
  tokenInfoService = null;
}


function isSaveRawEnabled() {
  return SAVE_RAW;
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
    const walletDir = sanitizeSegment(context && context.payerPubkey, 'wallet');
    const mintPart = sanitizeSegment(context && context.mint, 'mint');
    writeJsonArtifact(
      ARTIFACT_BASE_DIR,
      ['parseSwapTx', walletDir],
      `${mintPart}-${formatRunId()}.json`,
      payload,
    );
  } catch (err) {
    // Best-effort only: never let artifact writing break swap parsing.
  }
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

  const { meta, slot } = rawTx;
  if (!meta) return null;

  const { accountKeys } = resolveTransactionAccountKeys(rawTx);
  if (!accountKeys.length) return null;

  // --- Token deltas (for the specific mint + owner) ---
  const { deltasByMint } = computeTokenDeltasForOwner(meta, accountKeys, payerPubkey);
  let tokenDelta = 0;
  let tokenDecrease = 0;
  const diffToken = deltasByMint.get(mint) || 0;
  if (diffToken > 0) {
    tokenDelta = diffToken;
  } else if (diffToken < 0) {
    tokenDecrease = -diffToken;
  }

  // --- SOL delta for the payer ---
  const solDelta = computeSolDeltaForOwner(meta, accountKeys, payerPubkey);
  const solDiffLamports =
    typeof solDelta.deltaLamports === 'number' && Number.isFinite(solDelta.deltaLamports)
      ? solDelta.deltaLamports
      : null;
  const solDiff =
    typeof solDelta.deltaSol === 'number' && Number.isFinite(solDelta.deltaSol)
      ? solDelta.deltaSol
      : 0;

  // --- Network fee ---
  let feeLamports = null;
  if (Object.prototype.hasOwnProperty.call(meta, 'fee')) {
    const rawFee = Number(meta.fee);
    if (Number.isFinite(rawFee)) {
      feeLamports = rawFee;
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

  const client = (opts && (opts.client || opts.tokenInfoClient || opts.dataClient)) || null;

  try {
    // Best-effort enrichment. Our tokenInfoService.ensureTokenInfo requires a client.
    if (client && typeof tokenInfoService.ensureTokenInfo === 'function') {
      await tokenInfoService.ensureTokenInfo({ mint, client, forceRefresh: false });
    }

    if (typeof tokenInfoService.getTokenInfo === 'function') {
      // First attempt: getTokenInfo({ mint, client }) when available.
      try {
        tokenInfo = client
          ? await tokenInfoService.getTokenInfo({ mint, client })
          : await tokenInfoService.getTokenInfo({ mint });
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
