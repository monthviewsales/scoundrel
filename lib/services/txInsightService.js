/**
 * txInsightService
 * -----------------
 * Utilities for deriving pricing and trade insights from Solana transactions
 * and SolanaTracker trade history.
 *
 * This module is intentionally stateless and contains **no** bot/strategy
 * semantics, PnL writes, or BootyBox mutations. It is safe to use from
 * Warchest, Scoundrel jobs, or future trading engines.
 */
'use strict';

const path = require('path');
const {
  getSolanaErrorFromTransactionError,
  getSolanaErrorFromInstructionError,
} = require('@solana/kit');
const logger = require('../logger');
const { createSolanaTrackerRPCClient } = require('../solanaTrackerRPCClient');
const { createRpcMethods } = require('../solana/rpcMethods');
const walletRegistry = require('../wallets/walletRegistry');
const { isSolanaAddress } = require('../solana/addressValidation');
const {
  normalizePubkeyLike,
  resolveTransactionAccountKeys,
} = require('../solana/transactionAccounts');
const {
  computeSolDeltaForOwner,
  computeTokenDeltasByOwner,
  computeTokenDeltasForOwner,
} = require('../solana/transactionDeltas');
const { STABLE_MINT_LIST, isStableMint } = require('../solana/stableMints');

const {
  formatRunId,
  getArtifactConfig,
  sanitizeSegment,
  writeJsonArtifact,
} = require('../persist/jsonArtifacts');

const { rpc, rpcSubs } = createSolanaTrackerRPCClient();
const solanaTrackerRPC = createRpcMethods(rpc, rpcSubs);

const artifactConfig = getArtifactConfig();
const { saveRaw: SAVE_RAW } = artifactConfig;

// -----------------------------------------------------------------------------
// Token metadata helpers
// -----------------------------------------------------------------------------

// Local stablecoin registry; we treat these as non-tradable in the context of
// entry/exit price discovery because they are the numeraire.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const NON_TRADABLE_MINTS = new Set([SOL_MINT, ...STABLE_MINT_LIST]);

const MINT_LABELS = Object.freeze({
  [SOL_MINT]: 'SOL',
  [STABLE_MINT_LIST[0]]: 'USDC',
  [STABLE_MINT_LIST[1]]: 'USDT',
  [STABLE_MINT_LIST[2]]: 'USD1',
});

/**
 * Determine whether a mint should be treated as a non-tradable numeraire.
 *
 * @param {string} mint - Mint address.
 * @returns {boolean}
 */
function isNonTradableMint(mint) {
  if (!mint) return false;
  if (mint === SOL_MINT) return true;
  return isStableMint(mint) || NON_TRADABLE_MINTS.has(mint);
}

/**
 * Convert lamports to SOL, rejecting non-finite inputs early so callers
 * don't rely on implicit coercion.
 *
 * @param {number|bigint|string} lamports - Raw lamport count.
 * @returns {number}
 */
function lamportsToSol(lamports) {
  const lamportsNumber = Number(lamports);
  if (!Number.isFinite(lamportsNumber)) {
    throw new Error('lamports value is not a finite number');
  }
  return lamportsNumber / 1e9;
}

// -----------------------------------------------------------------------------
// General utilities
// -----------------------------------------------------------------------------

function buildWalletLookup(wallets) {
  const byPubkey = new Map();
  const byAlias = new Map();

  (wallets || []).forEach((wallet) => {
    if (!wallet) return;
    const pubkey = normalizePubkeyLike(wallet.pubkey);
    if (pubkey) {
      byPubkey.set(pubkey, wallet);
    }
    if (wallet.alias) {
      byAlias.set(String(wallet.alias).toLowerCase(), wallet);
    }
  });

  return { byPubkey, byAlias, wallets: wallets || [] };
}

async function loadWalletLookup() {
  try {
    const wallets = await walletRegistry.getAllWallets();
    return buildWalletLookup(wallets);
  } catch (err) {
    logger.warn(
      `[txInsightService] Failed to load wallet registry: ${err?.message || err}`
    );
    return buildWalletLookup([]);
  }
}

function resolveWalletIdentifier(identifier, lookup) {
  if (!identifier) return null;
  const trimmed = String(identifier).trim();
  if (!trimmed) return null;

  const aliasMatch = lookup.byAlias.get(trimmed.toLowerCase());
  if (aliasMatch) {
    return {
      pubkey: normalizePubkeyLike(aliasMatch.pubkey),
      alias: aliasMatch.alias || null,
      walletId: aliasMatch.walletId ?? aliasMatch.wallet_id ?? aliasMatch.id ?? null,
      record: aliasMatch,
    };
  }

  const normalized = normalizePubkeyLike(trimmed);
  if (normalized && isSolanaAddress(normalized)) {
    const record = lookup.byPubkey.get(normalized) || null;
    return {
      pubkey: normalized,
      alias: record ? record.alias || null : null,
      walletId: record ? (record.walletId ?? record.wallet_id ?? record.id ?? null) : null,
      record,
    };
  }

  return null;
}

function scoreWalletDeltas(deltasByMint) {
  let tradableScore = 0;
  let stableScore = 0;

  for (const [mint, delta] of deltasByMint.entries()) {
    const magnitude = Math.abs(delta);
    if (magnitude === 0) continue;
    if (isNonTradableMint(mint)) {
      if (magnitude > stableScore) stableScore = magnitude;
    } else if (magnitude > tradableScore) {
      tradableScore = magnitude;
    }
  }

  return { tradableScore, stableScore };
}

function pickWalletFromDeltas({ deltasByOwner, accountKeys, lookup }) {
  let best = null;
  let bestTradable = 0;
  let bestStable = 0;

  for (const [owner, deltasByMint] of deltasByOwner.entries()) {
    const record = lookup.byPubkey.get(owner);
    if (!record) continue;
    const scores = scoreWalletDeltas(deltasByMint);
    if (
      scores.tradableScore > bestTradable ||
      (scores.tradableScore === bestTradable && scores.stableScore > bestStable)
    ) {
      best = {
        pubkey: owner,
        alias: record.alias || null,
        walletId: record.walletId ?? record.wallet_id ?? record.id ?? null,
        record,
      };
      bestTradable = scores.tradableScore;
      bestStable = scores.stableScore;
    }
  }

  if (best) return best;

  for (const key of accountKeys || []) {
    const record = lookup.byPubkey.get(key);
    if (record) {
      return {
        pubkey: key,
        alias: record.alias || null,
        walletId: record.walletId ?? record.wallet_id ?? record.id ?? null,
        record,
      };
    }
  }

  return null;
}

function summarizeStableDeltas(deltasByMint) {
  let stableReceived = 0;
  let stableSpent = 0;
  let dominantMint = null;
  let dominantDelta = 0;

  for (const [mint, delta] of deltasByMint.entries()) {
    if (!isStableMint(mint)) continue;
    if (delta > 0) stableReceived += delta;
    if (delta < 0) stableSpent += Math.abs(delta);
    const magnitude = Math.abs(delta);
    if (magnitude > Math.abs(dominantDelta)) {
      dominantDelta = delta;
      dominantMint = mint;
    }
  }

  return {
    stableReceived,
    stableSpent,
    stableNet: stableReceived - stableSpent,
    dominantMint,
    dominantDelta,
  };
}

function pickPrimaryTokenDeltas(deltasByMint) {
  let outputMint = null;
  let outputDelta = 0;
  let inputMint = null;
  let inputDelta = 0;

  for (const [mint, delta] of deltasByMint.entries()) {
    if (!mint || isNonTradableMint(mint)) continue;
    if (delta > 0 && Math.abs(delta) > Math.abs(outputDelta)) {
      outputMint = mint;
      outputDelta = delta;
    }
    if (delta < 0 && Math.abs(delta) > Math.abs(inputDelta)) {
      inputMint = mint;
      inputDelta = Math.abs(delta);
    }
  }

  return { outputMint, outputDelta, inputMint, inputDelta };
}

function listCandidateWallets(walletAddress, lookup) {
  if (walletAddress) {
    const resolved = resolveWalletIdentifier(walletAddress, lookup);
    return resolved ? [resolved] : [];
  }

  return Array.from(lookup.byPubkey.values()).map((record) => ({
    pubkey: normalizePubkeyLike(record.pubkey),
    alias: record.alias || null,
    walletId: record.walletId ?? record.wallet_id ?? record.id ?? null,
    record,
  })).filter((entry) => entry.pubkey);
}

const DEFAULT_SIGNATURE_LIMIT = 50;
const MAX_SIGNATURES_TOTAL = 200;

async function collectSignaturesForWalletMint(walletPubkey, mint, opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : DEFAULT_SIGNATURE_LIMIT;
  const addresses = new Set();
  if (walletPubkey) addresses.add(walletPubkey);

  if (walletPubkey && mint) {
    try {
      const tokenAccounts = await solanaTrackerRPC.getTokenAccountsByOwnerV2(walletPubkey, {
        mint,
        encoding: 'jsonParsed',
      });
      (tokenAccounts.accounts || []).forEach((acct) => {
        if (acct && acct.pubkey) addresses.add(acct.pubkey);
      });
    } catch (err) {
      logger.warn(
        `[txInsightService] Failed to load token accounts for ${walletPubkey}/${mint}: ${err?.message || err}`
      );
    }
  }

  const signatureMap = new Map();

  // eslint-disable-next-line no-restricted-syntax
  for (const address of addresses) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await solanaTrackerRPC.getSignaturesForAddress(address, { limit });
      const entries = Array.isArray(response?.signatures) ? response.signatures : [];
      entries.forEach((entry) => {
        const signature = entry?.signature || entry;
        if (!signature || typeof signature !== 'string') return;
        const blockTime = Number(entry?.blockTime ?? entry?.block_time ?? 0);
        const slot = Number(entry?.slot ?? 0);
        const existing = signatureMap.get(signature);
        if (
          !existing ||
          blockTime > existing.blockTime ||
          (blockTime === existing.blockTime && slot > existing.slot)
        ) {
          signatureMap.set(signature, {
            signature,
            blockTime: Number.isFinite(blockTime) ? blockTime : 0,
            slot: Number.isFinite(slot) ? slot : 0,
          });
        }
      });
    } catch (err) {
      logger.warn(
        `[txInsightService] Failed to fetch signatures for ${address}: ${err?.message || err}`
      );
    }
  }

  const results = Array.from(signatureMap.values());
  results.sort((a, b) => {
    if (b.blockTime !== a.blockTime) return b.blockTime - a.blockTime;
    return b.slot - a.slot;
  });

  return results.slice(0, MAX_SIGNATURES_TOTAL);
}

async function findLatestSwapInsight({ mint, wallet, side, walletLookup }) {
  const walletPubkey = wallet && wallet.pubkey ? wallet.pubkey : wallet;
  if (!walletPubkey || !mint) return null;

  const signatures = await collectSignaturesForWalletMint(walletPubkey, mint, {});

  // eslint-disable-next-line no-restricted-syntax
  for (const entry of signatures) {
    const signature = entry.signature;
    if (!signature) continue;
    // eslint-disable-next-line no-await-in-loop
    const tx = await solanaTrackerRPC.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      encoding: 'jsonParsed',
    });
    if (!tx) continue;

    // eslint-disable-next-line no-await-in-loop
    const insight = await recoverSwapInsightFromTransaction(signature, tx, {
      walletAddress: walletPubkey,
      mint,
      walletLookup,
    });
    if (!insight || insight.kind === 'transfer') continue;
    if (side && insight.side !== side) continue;

    const priceUsd = Number(insight.priceUsdPerToken);
    if (Number.isFinite(priceUsd) && priceUsd > 0) {
      return { priceUsd, insight };
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Error diagnostics & artifacts
// -----------------------------------------------------------------------------

/**
 * Decode a raw RPC transaction error object into a SolanaError using
 * Solana Kit helpers. Returns null if decoding fails.
 *
 * @param {unknown} err - The `err` field from RPC transaction meta.
 * @returns {{ code: string, message: string, context?: unknown }|null}
 */
function decodeRpcTransactionError(err) {
  if (!err) return null;

  try {
    // Primary path: let Solana Kit interpret the transaction error shape.
    return getSolanaErrorFromTransactionError(err);
  } catch (outerErr) {
    // Fallback: if this looks like an InstructionError, try the instruction helper.
    try {
      if (err.InstructionError) {
        const [index, instructionError] = err.InstructionError;
        return getSolanaErrorFromInstructionError(index, instructionError);
      }
    } catch (innerErr) {
      // ignore and fall through to null
    }
  }

  return null;
}

/**
 * Best-effort debug artifact writer for swap insight failures. When
 * SAVE_RAW is enabled, this will write a JSON artifact containing the
 * raw transaction and context information to the swap insight folder
 * under /data (or SWAP_DEBUG_DIR if provided).
 *
 * @param {string} reason - Short reason code for why we are writing.
 * @param {object|null} tx - Raw transaction response (from RPC).
 * @param {object} [context={}] - Additional context to persist.
 */
function maybeWriteSwapDebugArtifact(reason, tx, context = {}) {
  if (!SAVE_RAW || !tx) {
    return;
  }

  const baseDir = process.env.SWAP_DEBUG_DIR
    ? path.resolve(process.env.SWAP_DEBUG_DIR)
    : path.join(process.cwd(), 'data');

  try {
    const txidFromTx = tx?.transaction?.signatures?.[0];
    const txid = context.txid || txidFromTx || 'unknown-txid';
    const safeId = sanitizeSegment(txid, 'unknown-txid');
    const safeReason = sanitizeSegment(reason, 'unknown-reason');

    const payload = {
      reason,
      txid,
      walletAddress: context.walletAddress || null,
      createdAt: new Date().toISOString(),
      meta: tx.meta || null,
      transaction: tx.transaction || null,
      context,
    };

    const filePath = writeJsonArtifact(
      baseDir,
      ['txInsight'],
      `swap-insight-${safeReason}-${safeId}-${formatRunId()}.json`,
      payload,
    );
    logger.debug(
      `[txInsightService] Wrote swap insight debug artifact for ${txid} to ${filePath}`,
    );
  } catch (err) {
    logger.warn(
      `[txInsightService] Failed to write swap insight debug artifact: ${err.message}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Historical price recovery utilities
// -----------------------------------------------------------------------------

/**
 * Attempts to recover the most recent buy price for a token using
 * SolanaTracker trade history for a specific wallet.
 *
 * @param {string} mint - Token mint address.
 * @param {string} walletAddress - Base58 wallet address whose trades to inspect.
 * @returns {Promise<number|null>} - Recovered entry price in USD (when a stable
 * quote is available), 0 for non-tradable mints, or null if no suitable trade
 * is found.
 */
async function recoverEntryPriceFromHistory(mint, walletAddress) {
  logger.debug(
    `[txInsightService] Attempting to recover entry price for ${mint} (wallet=${walletAddress || 'unknown'})`
  );

  if (isNonTradableMint(mint)) {
    const label = MINT_LABELS[mint] || mint;
    logger.debug(
      `[txInsightService] Skipping entry price recovery for ${label} — setting to 0`
    );
    return 0;
  }

  const lookup = await loadWalletLookup();
  const candidates = listCandidateWallets(walletAddress, lookup);
  if (!candidates.length) {
    logger.warn(
      `[txInsightService] recoverEntryPriceFromHistory could not resolve wallet ${walletAddress || 'unknown'}`
    );
    return null;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const wallet of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await findLatestSwapInsight({
        mint,
        wallet,
        side: 'buy',
        walletLookup: lookup,
      });
      if (result && Number.isFinite(result.priceUsd)) {
        logger.debug(
          `[txInsightService] Recovered entry price for ${mint} (wallet=${wallet.alias || wallet.pubkey}): priceUsd=${result.priceUsd}`
        );
        return result.priceUsd;
      }
    } catch (err) {
      logger.error(
        `[txInsightService] Failed to recover entry price for ${mint} (wallet=${wallet.alias || wallet.pubkey}): ${err.message}`
      );
    }
  }

  return null;
}

/**
 * Attempts to recover the most recent sell price for a token using
 * SolanaTracker trade history for a specific wallet.
 *
 * @param {string} mint - Token mint address.
 * @param {string} walletAddress - Base58 wallet address whose trades to inspect.
 * @returns {Promise<number|null>} - Recovered exit price in USD (when a stable
 * quote is available), 0 for non-tradable mints, or null if no suitable trade
 * is found.
 */
async function recoverSellPriceFromHistory(mint, walletAddress) {
  logger.debug(
    `[txInsightService] Attempting to recover sell price for ${mint} (wallet=${walletAddress || 'unknown'})`
  );

  if (isNonTradableMint(mint)) {
    const label = MINT_LABELS[mint] || mint;
    logger.debug(
      `[txInsightService] Skipping sell price recovery for ${label} — setting to 0`
    );
    return 0;
  }

  const lookup = await loadWalletLookup();
  const candidates = listCandidateWallets(walletAddress, lookup);
  if (!candidates.length) {
    logger.warn(
      `[txInsightService] recoverSellPriceFromHistory could not resolve wallet ${walletAddress || 'unknown'}`
    );
    return null;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const wallet of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await findLatestSwapInsight({
        mint,
        wallet,
        side: 'sell',
        walletLookup: lookup,
      });
      if (result && Number.isFinite(result.priceUsd)) {
        logger.debug(
          `[txInsightService] Recovered sell price for ${mint} (wallet=${wallet.alias || wallet.pubkey}): priceUsd=${result.priceUsd}`
        );
        return result.priceUsd;
      }
    } catch (err) {
      logger.error(
        `[txInsightService] Failed to recover sell price for ${mint} (wallet=${wallet.alias || wallet.pubkey}): ${err.message}`
      );
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Transaction insight recovery
// -----------------------------------------------------------------------------

/**
 * High-level swap insight for a single transaction and wallet.
 *
 * This is the canonical implementation for deriving wallet-centric swap
 * semantics (side, token/sol deltas, and price) from a single transaction.
 * All higher-level callers (HUD, CLI, etc.) should prefer this shape.
 *
 * @param {string} txid - Transaction signature.
 * @param {object|null} [txOverride] - Optional pre-fetched transaction object.
 * @param {object} [opts={}] - Optional parameters.
 * @param {string} [opts.walletAddress] - Wallet whose perspective to use.
 * @returns {Promise<{
 *   txid: string,
 *   walletAddress: string|null,
 *   walletAlias?: string|null,
 *   walletId?: string|number|null,
 *   mint: string|null,
 *   decimals: number,
 *   side: 'buy'|'sell'|'unknown',
 *   tokenDeltaNet: number,
 *   tokenDeltaIn: number,
 *   tokenDeltaOut: number,
 *   solDeltaNet: number,
 *   solDeltaIn: number,
 *   solDeltaOut: number,
 *   priceSolPerToken: number|null,
 *   priceUsdPerToken: number|null,
 *   executedAt: number|null,
 *   feeLamports: number,
 *   feeSol: number,
 * }|null>} - Derived swap insight, or null if it cannot be determined.
 */
async function recoverSwapInsightFromTransaction(txid, txOverride = null, opts = {}) {
  let tx = txOverride;
  if (!tx) {
    tx = await solanaTrackerRPC.getTransaction(txid, {
      maxSupportedTransactionVersion: 0,
      encoding: 'jsonParsed',
    });
  }

  if (!tx) {
    logger.warn(
      `[txInsightService] Transaction ${txid} not available for swap insight.`
    );
    return null;
  }

  try {
    const walletAddressInput = opts.walletAddress || opts.owner || null;
    const requestedMint = opts.mint ? normalizePubkeyLike(opts.mint) : null;

    const { accountKeys } = resolveTransactionAccountKeys(tx);
    if (!accountKeys.length) {
      logger.warn(
        `[txInsightService] Missing account keys for transaction ${txid}; cannot derive swap insight.`
      );
      maybeWriteSwapDebugArtifact('missing-account-keys', tx, {
        txid,
        walletAddress: null,
        walletAddressInput,
      });
      return null;
    }

    const meta = tx.meta;
    if (!meta) {
      logger.warn(
        `[txInsightService] Missing meta for transaction ${txid}; cannot derive swap insight.`
      );
      maybeWriteSwapDebugArtifact('missing-meta', tx, {
        txid,
        walletAddress: null,
        walletAddressInput,
      });
      return null;
    }

    if (meta && meta.err) {
      const decoded = decodeRpcTransactionError(meta.err);
      if (decoded) {
        logger.info(
          `[txInsightService] Transaction ${txid} failed: ${decoded.code} - ${decoded.message}`
        );
      } else {
        logger.info(
          `[txInsightService] Transaction ${txid} failed with raw RPC error: ${JSON.stringify(meta.err)}`
        );
      }

      maybeWriteSwapDebugArtifact('failed-transaction', tx, {
        txid,
        walletAddress: null,
        walletAddressInput,
        rawError: meta.err,
        decodedError: decoded || null,
      });

      return null;
    }

    const lookup =
      opts.walletLookup && opts.walletLookup.byPubkey
        ? opts.walletLookup
        : await loadWalletLookup();
    const resolvedWallet = walletAddressInput
      ? resolveWalletIdentifier(walletAddressInput, lookup)
      : null;

    const { deltasByOwner, decimalsByMint } = computeTokenDeltasByOwner(
      meta,
      accountKeys
    );

    let wallet = resolvedWallet;
    if (!wallet) {
      wallet = pickWalletFromDeltas({ deltasByOwner, accountKeys, lookup });
    }

    let normalizedWallet = wallet ? wallet.pubkey : null;
    const walletAlias = wallet ? wallet.alias : null;
    const walletId = wallet ? wallet.walletId : null;

    if (!normalizedWallet && accountKeys.length > 0) {
      normalizedWallet = accountKeys[0];
    }

    if (!normalizedWallet) {
      logger.warn(
        `[txInsightService] Unable to resolve wallet context for ${txid}; cannot derive swap insight.`
      );
      return null;
    }

    let deltasByMint = deltasByOwner.get(normalizedWallet) || new Map();
    if (!deltasByMint.size) {
      const ownerDeltas = computeTokenDeltasForOwner(
        meta,
        accountKeys,
        normalizedWallet
      );
      deltasByMint = ownerDeltas.deltasByMint;
      ownerDeltas.decimalsByMint.forEach((value, mint) => {
        if (!decimalsByMint.has(mint)) decimalsByMint.set(mint, value);
      });
    }

    const solDelta = computeSolDeltaForOwner(
      meta,
      accountKeys,
      normalizedWallet
    );
    const solDeltaNet =
      typeof solDelta.deltaSol === 'number' && Number.isFinite(solDelta.deltaSol)
        ? solDelta.deltaSol
        : 0;
    const solDeltaIn = solDeltaNet > 0 ? solDeltaNet : 0;
    const solDeltaOut = solDeltaNet < 0 ? -solDeltaNet : 0;

    const blockTimeMs =
      typeof tx.blockTime === 'number' && Number.isFinite(tx.blockTime)
        ? tx.blockTime * 1000
        : null;
    const feeLamports = Number(meta.fee ?? 0);
    const feeSol = Number.isFinite(feeLamports) ? lamportsToSol(feeLamports) : 0;

    const stableSummary = summarizeStableDeltas(deltasByMint);
    const hasStableDelta =
      stableSummary.stableSpent > 0 || stableSummary.stableReceived > 0;

    const { outputMint, outputDelta, inputMint, inputDelta } =
      pickPrimaryTokenDeltas(deltasByMint);
    const hasTradableDelta = !!outputMint || !!inputMint;

    let chosenMint = requestedMint || outputMint || inputMint || null;
    let tokenDeltaNet = 0;
    let chosenDecimals = 0;

    if (chosenMint) {
      if (requestedMint) {
        tokenDeltaNet = deltasByMint.get(chosenMint) || 0;
      } else if (chosenMint === outputMint) {
        tokenDeltaNet = outputDelta;
      } else if (chosenMint === inputMint) {
        tokenDeltaNet = -inputDelta;
      }
      chosenDecimals = decimalsByMint.get(chosenMint) || 0;
    }

    if (requestedMint && tokenDeltaNet === 0) {
      logger.debug(
        `[txInsightService] No token delta for requested mint ${requestedMint} in ${txid}.`
      );
      return null;
    }

    if (!hasTradableDelta && (hasStableDelta || solDeltaNet !== 0)) {
      if (hasStableDelta) {
        const stableMint =
          requestedMint || stableSummary.dominantMint || STABLE_MINT_LIST[0];
        const stableNet = requestedMint ? tokenDeltaNet : stableSummary.stableNet;
        const stableIn = stableNet > 0 ? stableNet : 0;
        const stableOut = stableNet < 0 ? -stableNet : 0;

        logger.info(
          `[txInsightService] Treating ${txid} as stable transfer; no tradable token deltas detected.`
        );
        return {
          txid,
          walletAddress: normalizedWallet,
          walletAlias,
          walletId,
          kind: 'transfer',
          label: 'transfer',
          mint: stableMint,
          decimals: decimalsByMint.get(stableMint) || 0,
          side: null,
          tokenDeltaNet: stableNet,
          tokenDeltaIn: stableIn,
          tokenDeltaOut: stableOut,
          solDeltaNet,
          solDeltaIn,
          solDeltaOut,
          priceSolPerToken: null,
          priceUsdPerToken: null,
          executedAt: blockTimeMs,
          feeLamports,
          feeSol,
        };
      }

      logger.info(
        `[txInsightService] Treating ${txid} as transfer; no token deltas detected.`
      );
      return {
        txid,
        walletAddress: normalizedWallet,
        walletAlias,
        walletId,
        kind: 'transfer',
        label: 'transfer',
        mint: SOL_MINT,
        decimals: 9,
        side: null,
        tokenDeltaNet: 0,
        tokenDeltaIn: 0,
        tokenDeltaOut: 0,
        solDeltaNet,
        solDeltaIn,
        solDeltaOut,
        priceSolPerToken: null,
        priceUsdPerToken: null,
        executedAt: blockTimeMs,
        feeLamports,
        feeSol,
      };
    }

    const MINIMUM_DELTA_THRESHOLD = 0.000001;
    const tokenDeltaMagnitude = Math.abs(tokenDeltaNet);
    if (!chosenMint || tokenDeltaMagnitude < MINIMUM_DELTA_THRESHOLD) {
      return null;
    }

    let priceSolPerToken = null;
    let priceUsdPerToken = null;

    if (!isNonTradableMint(chosenMint)) {
      if (tokenDeltaNet > 0 && stableSummary.stableSpent > 0) {
        priceUsdPerToken = stableSummary.stableSpent / tokenDeltaMagnitude;
      } else if (tokenDeltaNet < 0 && stableSummary.stableReceived > 0) {
        priceUsdPerToken = stableSummary.stableReceived / tokenDeltaMagnitude;
      }

      if (!priceUsdPerToken || !Number.isFinite(priceUsdPerToken)) {
        if (tokenDeltaNet > 0 && solDeltaOut > 0) {
          priceSolPerToken = solDeltaOut / tokenDeltaMagnitude;
        } else if (tokenDeltaNet < 0 && solDeltaIn > 0) {
          priceSolPerToken = solDeltaIn / tokenDeltaMagnitude;
        }
      }
    }

    let side = 'unknown';
    if (tokenDeltaNet > 0 && (stableSummary.stableSpent > 0 || solDeltaNet < 0)) {
      side = 'buy';
    } else if (
      tokenDeltaNet < 0 &&
      (stableSummary.stableReceived > 0 || solDeltaNet > 0)
    ) {
      side = 'sell';
    } else if (tokenDeltaNet !== 0) {
      side = tokenDeltaNet > 0 ? 'buy' : 'sell';
    }

    if (Number.isFinite(priceUsdPerToken) && priceUsdPerToken > 0) {
      logger.info(
        `[txInsightService] Recovered price for ${txid}: ${priceUsdPerToken} USD per unit of ${chosenMint}`
      );
    } else if (Number.isFinite(priceSolPerToken) && priceSolPerToken > 0) {
      const mintLabel = chosenMint ? MINT_LABELS[chosenMint] || chosenMint : '?';
      logger.info(
        `[txInsightService] Recovered price for ${txid}: ${priceSolPerToken} SOL per unit of ${mintLabel}`
      );
    }

    const tokenDeltaIn = tokenDeltaNet > 0 ? tokenDeltaNet : 0;
    const tokenDeltaOut = tokenDeltaNet < 0 ? -tokenDeltaNet : 0;

    return {
      txid,
      walletAddress: normalizedWallet,
      walletAlias,
      walletId,
      mint: chosenMint,
      decimals: chosenDecimals,
      side,
      tokenDeltaNet,
      tokenDeltaIn,
      tokenDeltaOut,
      solDeltaNet,
      solDeltaIn,
      solDeltaOut,
      priceSolPerToken,
      priceUsdPerToken,
      executedAt: blockTimeMs,
      feeLamports,
      feeSol,
    };
  } catch (err) {
    logger.error(
      `[txInsightService] Error parsing transaction ${txid}: ${err.message}`
    );
    return null;
  }
}

/**
 * Legacy price-focused wrapper retained for historical callers.
 *
 * @deprecated Prefer recoverSwapInsightFromTransaction for richer output.
 * @param {string} txid - Transaction signature.
 * @param {object|null} [txOverride] - Optional pre-fetched transaction.
 * @param {object} [opts] - Additional options passed to swap insight recovery.
 * @returns {Promise<{
 *   priceSolPerToken: number,
 *   tokenDelta: number,
 *   solDelta: number,
 *   mint: string|null,
 *   decimals: number,
 *   executedAt: number|null,
 * }|null>}
 */
async function recoverPriceFromTransactionv2(txid, txOverride = null, opts = {}) {
  const insight = await recoverSwapInsightFromTransaction(txid, txOverride, opts);
  if (!insight) {
    return null;
  }

  const {
    priceSolPerToken,
    tokenDeltaNet,
    solDeltaNet,
    mint,
    decimals,
    executedAt,
  } = insight;

  return {
    priceSolPerToken,
    tokenDelta: tokenDeltaNet,
    solDelta: solDeltaNet,
    mint,
    decimals,
    executedAt,
  };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  recoverSwapInsightFromTransaction,
  recoverPriceFromTransactionv2,  // deprecated - prefer recoverSwapInsightFromTransaction instead
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
  decodeRpcTransactionError,
};
