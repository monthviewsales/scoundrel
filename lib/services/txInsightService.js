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

const fs = require('fs');
const path = require('path');
const {
  getSolanaErrorFromTransactionError,
  getSolanaErrorFromInstructionError,
} = require('@solana/kit');
const logger = require('../logger');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const { createSolanaTrackerRPCClient } = require('../solanaTrackerRPCClient');
const { createRpcMethods } = require('../solana/rpcMethods');

const solanaTrackerDataClient = createSolanaTrackerDataClient();
const { rpc, rpcSubs } = createSolanaTrackerRPCClient();
const solanaTrackerRPC = createRpcMethods(rpc, rpcSubs);

// Local stablecoin map; we treat these as non-tradable in the context of
// entry/exit price discovery because they are the numeraire.
const STABLECOIN_MAP = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const NON_TRADABLE_MINTS = new Set(Object.values(STABLECOIN_MAP));

const MINT_LABELS = Object.freeze({
  [STABLECOIN_MAP.SOL]: 'SOL',
  [STABLECOIN_MAP.USDC]: 'USDC',
});

function isNonTradableMint(mint) {
  return Boolean(mint) && NON_TRADABLE_MINTS.has(mint);
}

function lamportsToSol(lamports) {
  const lamportsNumber = Number(lamports);
  if (!Number.isFinite(lamportsNumber)) {
    throw new Error('lamports value is not a finite number');
  }
  return lamportsNumber / 1e9;
}

/**
 * Normalize a public key-like value (string, PublicKey, or object with
 * toBase58/toString) into a base58 string. Returns null if it cannot be
 * normalized.
 *
 * @param {*} value
 * @returns {string|null}
 */
function normalizePubkeyLike(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  // PublicKey-ish objects with toBase58()
  if (typeof value.toBase58 === 'function') {
    try {
      const s = value.toBase58();
      return typeof s === 'string' && s ? s : null;
    } catch (err) {
      return null;
    }
  }

  // Fallback to toString() if present.
  if (typeof value.toString === 'function') {
    try {
      const s = value.toString();
      return typeof s === 'string' && s ? s : null;
    } catch (err) {
      return null;
    }
  }

  // Some callers may pass an object with a publicKey/pubkey field.
  if (value.publicKey) {
    return normalizePubkeyLike(value.publicKey);
  }
  if (value.pubkey) {
    return normalizePubkeyLike(value.pubkey);
  }

  return null;
}

/**
 * Convert a number/string/bigint into a BigInt, or null if not possible.
 *
 * @param {*} value
 * @returns {bigint|null}
 */
function toBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^[-+]?\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch (err) {
      return null;
    }
  }

  return null;
}

/**
 * Determine whether debug artifact writing is enabled.
 * Controlled via SAVE_RAW env var ("1", "true", "yes").
 *
 * @returns {boolean}
 */
function isSaveRawEnabled() {
  const flag = process.env.SAVE_RAW;
  if (!flag) return false;
  const normalized = String(flag).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const SWAP_DEBUG_ARTIFACT_DIR = process.env.SWAP_DEBUG_DIR
  || path.join(process.cwd(), 'artifacts', 'swap-insight');

/**
 * JSON.stringify that is safe for BigInt values by converting them to
 * strings. Indents with 2 spaces for readability.
 *
 * @param {*} value
 * @returns {string}
 */
function jsonSafeStringify(value) {
  return JSON.stringify(
    value,
    (key, val) => (typeof val === 'bigint' ? val.toString() : val),
    2,
  );
}

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
 * raw transaction and context information to SWAP_DEBUG_ARTIFACT_DIR.
 *
 * @param {string} reason - Short reason code for why we are writing.
 * @param {object|null} tx - Raw transaction response (from RPC).
 * @param {object} [context={}] - Additional context to persist.
 */
function maybeWriteSwapDebugArtifact(reason, tx, context = {}) {
  if (!isSaveRawEnabled() || !tx) {
    return;
  }

  try {
    const txidFromTx = tx?.transaction?.signatures?.[0];
    const txid = context.txid || txidFromTx || 'unknown-txid';
    const safeId = String(txid).replace(/[^a-zA-Z0-9_-]/g, '_');

    const payload = {
      reason,
      txid,
      walletAddress: context.walletAddress || null,
      createdAt: new Date().toISOString(),
      meta: tx.meta || null,
      transaction: tx.transaction || null,
      context,
    };

    fs.mkdirSync(SWAP_DEBUG_ARTIFACT_DIR, { recursive: true });
    const filePath = path.join(
      SWAP_DEBUG_ARTIFACT_DIR,
      `swap-insight-${safeId}-${Date.now()}.json`,
    );

    fs.writeFileSync(filePath, jsonSafeStringify(payload), 'utf8');
    logger.debug(
      `[txInsightService] Wrote swap insight debug artifact for ${txid} to ${filePath}`,
    );
  } catch (err) {
    logger.warn(
      `[txInsightService] Failed to write swap insight debug artifact: ${err.message}`,
    );
  }
}

/**
 * Attempts to recover the most recent buy price for a token using
 * SolanaTracker trade history for a specific wallet.
 *
 * @param {string} mint - Token mint address.
 * @param {string} walletAddress - Base58 wallet address whose trades to inspect.
 * @returns {Promise<number|null>} - Recovered entry price in USD, 0 for
 * non-tradable mints, or null if no suitable trade is found.
 */
async function recoverEntryPriceFromHistory(mint, walletAddress) {
  logger.debug(
    `[txInsightService] Attempting to recover entry price for ${mint} (wallet=${walletAddress || 'unknown'})`
  );

  if (!walletAddress) {
    logger.warn(
      '[txInsightService] recoverEntryPriceFromHistory called without walletAddress; returning null'
    );
    return null;
  }

  if (isNonTradableMint(mint)) {
    const label = MINT_LABELS[mint] || mint;
    logger.debug(
      `[txInsightService] Skipping entry price recovery for ${label} — setting to 0`
    );
    return 0;
  }

  try {
    // Wallet/mint pair – this is intentionally scoped to a single token.
    const history = await solanaTrackerDataClient.getUserTokenTrades(
      mint,
      walletAddress
    );

    const trades =
      (Array.isArray(history) && history) ||
      history?.trades ||
      history?.results ||
      history?.data?.trades ||
      history?.data?.results ||
      [];

    if (!Array.isArray(trades) || trades.length === 0) {
      logger.warn(
        `[txInsightService] No trade history found for mint ${mint} and wallet ${walletAddress}`
      );
      return null;
    }

    const latestBuy = trades.find((t) => t && t.type === 'buy');
    const priceUsd = latestBuy?.priceUsd ?? latestBuy?.price_usd;

    if (latestBuy && Number.isFinite(Number(priceUsd)) && Number(priceUsd) > 0) {
      const entryPrice = Number(priceUsd);
      logger.debug(
        `[txInsightService] Recovered entry price for ${mint}: priceUsd=${entryPrice}`
      );
      return entryPrice;
    }

    logger.warn(
      `[txInsightService] Invalid or missing priceUsd in latest buy for ${mint}`
    );
  } catch (err) {
    logger.error(
      `[txInsightService] Failed to recover entry price for ${mint}: ${err.message}`
    );
  }

  return null;
}

/**
 * Attempts to recover the most recent sell price for a token using
 * SolanaTracker trade history for a specific wallet.
 *
 * @param {string} mint - Token mint address.
 * @param {string} walletAddress - Base58 wallet address whose trades to inspect.
 * @returns {Promise<number|null>} - Recovered exit price in USD, 0 for
 * non-tradable mints, or null if no suitable trade is found.
 */
async function recoverSellPriceFromHistory(mint, walletAddress) {
  logger.debug(
    `[txInsightService] Attempting to recover sell price for ${mint} (wallet=${walletAddress || 'unknown'})`
  );

  if (!walletAddress) {
    logger.warn(
      '[txInsightService] recoverSellPriceFromHistory called without walletAddress; returning null'
    );
    return null;
  }

  if (isNonTradableMint(mint)) {
    const label = MINT_LABELS[mint] || mint;
    logger.debug(
      `[txInsightService] Skipping sell price recovery for ${label} — setting to 0`
    );
    return 0;
  }

  try {
    const history = await solanaTrackerDataClient.getUserTokenTrades(
      mint,
      walletAddress
    );

    const trades =
      (Array.isArray(history) && history) ||
      history?.trades ||
      history?.results ||
      history?.data?.trades ||
      history?.data?.results ||
      [];

    if (!Array.isArray(trades) || trades.length === 0) {
      logger.warn(
        `[txInsightService] No trade history found for mint ${mint} and wallet ${walletAddress}`
      );
      return null;
    }

    const latestSell = trades.find((t) => t && t.type === 'sell');
    const priceUsd = latestSell?.priceUsd ?? latestSell?.price_usd;

    if (latestSell && Number.isFinite(Number(priceUsd)) && Number(priceUsd) > 0) {
      const exitPrice = Number(priceUsd);
      logger.debug(
        `[txInsightService] Recovered sell price for ${mint}: priceUsd=${exitPrice}`
      );
      return exitPrice;
    }

    logger.warn(
      `[txInsightService] Invalid or missing priceUsd in latest sell for ${mint}`
    );
  } catch (err) {
    logger.error(
      `[txInsightService] Failed to recover sell price for ${mint}: ${err.message}`
    );
  }

  return null;
}


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
 *   mint: string|null,
 *   decimals: number,
 *   side: 'buy'|'sell'|'unknown',
 *   tokenDeltaNet: number,
 *   tokenDeltaIn: number,
 *   tokenDeltaOut: number,
 *   solDeltaNet: number,
 *   solDeltaIn: number,
 *   solDeltaOut: number,
 *   priceSolPerToken: number,
 *   executedAt: number|null,
 *   feeLamports: number,
 *   feeSol: number,
 * }|null>} - Derived swap insight, or null if it cannot be determined.
 */
async function recoverSwapInsightFromTransaction(txid, txOverride = null, opts = {}) {
  let tx = txOverride;
  if (!tx) {
    tx = await solanaTrackerRPC.getTransaction(txid);
  }

  if (!tx) {
    logger.warn(
      `[txInsightService] Transaction ${txid} not available for swap insight.`
    );
    return null;
  }

  try {
    const walletAddressInput = opts.walletAddress || opts.owner || null;

    const accountKeys = Array.isArray(
      tx?.transaction?.message?.accountKeys
    )
      ? tx.transaction.message.accountKeys.map((k) => String(k))
      : [];

    let normalizedWallet = null;

    if (walletAddressInput) {
      const candidate = String(walletAddressInput).trim();
      // Simple base58-ish pattern; this is intentionally loose but good enough
      // to distinguish aliases like "warlord" from real pubkeys.
      const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      if (base58Pattern.test(candidate)) {
        normalizedWallet = candidate;
      } else if (accountKeys.length > 0) {
        logger.debug(
          `[txInsightService] walletAddress "${walletAddressInput}" does not look like a base58 address; using fee payer ${accountKeys[0]} for ${txid}.`,
        );
        normalizedWallet = accountKeys[0];
      }
    }

    // If we still don't have a wallet, fall back to fee payer when available.
    if (!normalizedWallet && accountKeys.length > 0) {
      normalizedWallet = accountKeys[0];
    }

    const meta = tx.meta;
    if (!meta) {
      logger.warn(
        `[txInsightService] Missing meta for transaction ${txid}; cannot derive swap insight.`
      );
      maybeWriteSwapDebugArtifact('missing-meta', tx, {
        txid,
        walletAddress: normalizedWallet,
        walletAddressInput,
      });
      return null;
    }

    if (meta && meta.err) {
      const decoded = decodeRpcTransactionError(meta.err);
      if (decoded) {
        logger.info(
          `[txInsightService] Transaction ${txid} failed: ${decoded.code} - ${decoded.message}`,
        );
      } else {
        logger.info(
          `[txInsightService] Transaction ${txid} failed with raw RPC error: ${JSON.stringify(meta.err)}`,
        );
      }

      maybeWriteSwapDebugArtifact('failed-transaction', tx, {
        txid,
        walletAddress: normalizedWallet,
        walletAddressInput,
        rawError: meta.err,
        decodedError: decoded || null,
      });

      return null;
    }

    const resolveOwner = (entry) => {
      if (!entry) return null;
      if (entry.owner) return String(entry.owner);
      const idx = entry.accountIndex;
      if (
        typeof idx === 'number' &&
        idx >= 0 &&
        idx < accountKeys.length &&
        accountKeys[idx]
      ) {
        return String(accountKeys[idx]);
      }
      return null;
    };

    const preBalances = Array.isArray(meta.preBalances) ? meta.preBalances : [];
    const postBalances = Array.isArray(meta.postBalances)
      ? meta.postBalances
      : [];

    const preLamports = Number(preBalances[0] ?? 0);
    const postLamports = Number(postBalances[0] ?? 0);

    if (!Number.isFinite(preLamports) || !Number.isFinite(postLamports)) {
      logger.warn(
        `[txInsightService] Invalid SOL balances for ${txid}; cannot compute SOL delta.`
      );
      maybeWriteSwapDebugArtifact('invalid-sol-balances', tx, {
        txid,
        walletAddress: normalizedWallet,
        walletAddressInput,
      });
      return null;
    }

    const solDeltaLamports = postLamports - preLamports;
    const solDeltaNet = solDeltaLamports / 1e9;
    const solSpent = solDeltaLamports < 0 ? lamportsToSol(-solDeltaLamports) : 0;
    const solReceived = solDeltaLamports > 0 ? lamportsToSol(solDeltaLamports) : 0;

    const preTokenBalances = Array.isArray(meta.preTokenBalances)
      ? meta.preTokenBalances
      : [];
    const postTokenBalances = Array.isArray(meta.postTokenBalances)
      ? meta.postTokenBalances
      : [];

    const deltasByMint = new Map();
    const decimalsByMint = new Map();

    const addDelta = (mint, deltaUi, decimals) => {
      if (!mint || !Number.isFinite(deltaUi)) return;
      const prev = deltasByMint.get(mint) || 0;
      deltasByMint.set(mint, prev + deltaUi);
      if (!decimalsByMint.has(mint) && Number.isFinite(decimals)) {
        decimalsByMint.set(mint, decimals);
      }
    };

    if (normalizedWallet) {
      const preTotals = new Map();
      const postTotals = new Map();

      for (const pre of preTokenBalances) {
        if (!pre) continue;
        const owner = resolveOwner(pre);
        if (owner !== normalizedWallet) continue;
        const mint = pre.mint;
        if (!mint) continue;
        const ui = Number(
          pre.uiTokenAmount?.uiAmount ?? pre.uiTokenAmount?.amount ?? 0
        );
        if (!Number.isFinite(ui)) continue;
        preTotals.set(mint, (preTotals.get(mint) || 0) + ui);
        const decimals = Number(pre.uiTokenAmount?.decimals ?? 0);
        if (Number.isFinite(decimals) && !decimalsByMint.has(mint)) {
          decimalsByMint.set(mint, decimals);
        }
      }

      for (const post of postTokenBalances) {
        if (!post) continue;
        const owner = resolveOwner(post);
        if (owner !== normalizedWallet) continue;
        const mint = post.mint;
        if (!mint) continue;
        const ui = Number(
          post.uiTokenAmount?.uiAmount ?? post.uiTokenAmount?.amount ?? 0
        );
        if (!Number.isFinite(ui)) continue;
        postTotals.set(mint, (postTotals.get(mint) || 0) + ui);
        const decimals = Number(post.uiTokenAmount?.decimals ?? 0);
        if (Number.isFinite(decimals) && !decimalsByMint.has(mint)) {
          decimalsByMint.set(mint, decimals);
        }
      }

      const allMints = new Set([
        ...preTotals.keys(),
        ...postTotals.keys(),
      ]);

      for (const mint of allMints) {
        const preTotal = preTotals.get(mint) || 0;
        const postTotal = postTotals.get(mint) || 0;
        const deltaUi = postTotal - preTotal;
        if (!Number.isFinite(deltaUi) || deltaUi === 0) continue;
        addDelta(mint, deltaUi, decimalsByMint.get(mint));
      }
    } else {
      const preMap = new Map();
      for (const pre of preTokenBalances) {
        if (!pre) continue;
        const key = `${pre.mint || ''}:${resolveOwner(pre) || ''}:$${pre.accountIndex ?? ''}`;
        preMap.set(key, pre);
      }

      for (const post of postTokenBalances) {
        if (!post) continue;
        const key = `${post.mint || ''}:${resolveOwner(post) || ''}:$${post.accountIndex ?? ''}`;
        const pre = preMap.get(key);

        const preUi = Number(
          pre?.uiTokenAmount?.uiAmount ?? pre?.uiTokenAmount?.amount ?? 0
        );
        const postUi = Number(
          post?.uiTokenAmount?.uiAmount ?? post?.uiTokenAmount?.amount ?? 0
        );
        const decimals = Number(
          post?.uiTokenAmount?.decimals ?? pre?.uiTokenAmount?.decimals ?? 0
        );

        addDelta(post.mint, postUi - preUi, decimals);
        preMap.delete(key);
      }

      for (const pre of preMap.values()) {
        if (!pre) continue;
        const preUi = Number(
          pre.uiTokenAmount?.uiAmount ?? pre.uiTokenAmount?.amount ?? 0
        );
        const decimals = Number(pre.uiTokenAmount?.decimals ?? 0);
        addDelta(pre.mint, -preUi, decimals);
      }
    }

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

    const MINIMUM_DELTA_THRESHOLD = 0.000001;

    let priceSolPerToken = null;
    let chosenMint = null;
    let chosenDecimals = 0;
    let tokenDeltaMagnitude = 0;

    if (solSpent > 0 && outputMint && outputDelta > MINIMUM_DELTA_THRESHOLD) {
      tokenDeltaMagnitude = outputDelta;
      priceSolPerToken = solSpent / tokenDeltaMagnitude;
      chosenMint = outputMint;
      chosenDecimals = decimalsByMint.get(outputMint) || 0;
    } else if (
      solReceived > 0 &&
      inputMint &&
      inputDelta > MINIMUM_DELTA_THRESHOLD
    ) {
      tokenDeltaMagnitude = inputDelta;
      priceSolPerToken = solReceived / tokenDeltaMagnitude;
      chosenMint = inputMint;
      chosenDecimals = decimalsByMint.get(inputMint) || 0;
    }

    if (
      !Number.isFinite(priceSolPerToken) ||
      priceSolPerToken === null ||
      priceSolPerToken <= 0
    ) {
      logger.warn(
        `[txInsightService] Unable to derive price for ${txid}; token/sol deltas did not match expected patterns.`
      );

      const deltasSnapshot = Array.from(deltasByMint.entries());
      maybeWriteSwapDebugArtifact('unable-to-derive-price', tx, {
        txid,
        walletAddress: normalizedWallet,
        walletAddressInput,
        deltasByMint: deltasSnapshot,
        solDeltaNet,
        solSpent,
        solReceived,
      });

      return null;
    }

    const walletTokenDeltaSigned =
      chosenMint && deltasByMint.has(chosenMint)
        ? deltasByMint.get(chosenMint)
        : 0;

    let side = 'unknown';
    if (walletTokenDeltaSigned > 0 && solDeltaNet < 0) {
      side = 'buy';
    } else if (walletTokenDeltaSigned < 0 && solDeltaNet > 0) {
      side = 'sell';
    }

    const mintLabel = chosenMint ? MINT_LABELS[chosenMint] || chosenMint : '?';
    logger.info(
      `[txInsightService] Recovered price for ${txid}: ${priceSolPerToken} SOL per unit of ${mintLabel}`
    );

    const tokenDeltaNet = walletTokenDeltaSigned || 0;
    const tokenDeltaIn = tokenDeltaNet > 0 ? tokenDeltaNet : 0;
    const tokenDeltaOut = tokenDeltaNet < 0 ? -tokenDeltaNet : 0;
    const solDeltaIn = solDeltaNet > 0 ? solDeltaNet : 0;
    const solDeltaOut = solDeltaNet < 0 ? -solDeltaNet : 0;

    const blockTimeMs =
      typeof tx.blockTime === 'number' && Number.isFinite(tx.blockTime)
        ? tx.blockTime * 1000
        : null;

    const feeLamports = Number(meta.fee ?? 0);
    const feeSol = Number.isFinite(feeLamports) ? lamportsToSol(feeLamports) : 0;

    return {
      txid,
      walletAddress: normalizedWallet,
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

module.exports = {
  recoverSwapInsightFromTransaction,
  recoverPriceFromTransactionv2,  //depricated - use recoverSwapInsightFromTransaction instead
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
  decodeRpcTransactionError,
};
