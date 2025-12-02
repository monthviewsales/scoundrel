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
 * Attempts to recover an effective price for a swap from a single transaction.
 *
 * This implementation focuses on simple SOL &lt;-&gt; SPL flows where a single
 * wallet pays or receives SOL and a single SPL mint balance changes. For more
 * complex routes (multi-hop or token-token swaps) this will likely return null.
 *
 * @param {string} txid - Transaction signature.
 * @param {object|null} [txOverride] - Optional pre-fetched transaction object.
 * @param {object} [opts={}] - Optional parameters.
 * @param {string} [opts.walletAddress] - If provided, compute token balance deltas only for this wallet owner.
 * @returns {Promise<{
 *   priceSolPerToken: number,
 *   tokenDelta: number,
 *   solDelta: number,
 *   mint: string|null,
 *   decimals: number,
 * }|null>} - Derived pricing info, or null if it cannot be determined.
 */
async function recoverPriceFromTransactionv2(txid, txOverride = null, opts = {}) {
  let tx = txOverride;
  if (!tx) {
    tx = await solanaTrackerRPC.getTransaction(txid);
  }

  if (!tx) {
    logger.warn(
      `[txInsightService] Transaction ${txid} not available for price recovery.`
    );
    return null;
  }

  try {
    const meta = tx.meta;
    if (!meta) {
      logger.warn(
        `[txInsightService] Missing meta for transaction ${txid}; cannot derive price.`
      );
      return null;
    }

    const walletAddress = opts.walletAddress || opts.owner || null;

    const accountKeys = Array.isArray(
      tx?.transaction?.message?.accountKeys
    )
      ? tx.transaction.message.accountKeys.map((k) => String(k))
      : [];

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
    const postBalances = Array.isArray(meta.postBalances) ? meta.postBalances : [];

    const preLamports = Number(preBalances[0] ?? 0);
    const postLamports = Number(postBalances[0] ?? 0);

    if (!Number.isFinite(preLamports) || !Number.isFinite(postLamports)) {
      logger.warn(
        `[txInsightService] Invalid SOL balances for ${txid}; cannot compute SOL delta.`
      );
      return null;
    }

    const solDeltaLamports = postLamports - preLamports;
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

    const normalizedWallet = walletAddress ? String(walletAddress) : null;

    if (normalizedWallet) {
      // Wallet-scoped aggregation: we only care about token balance changes
      // for the provided wallet owner. This avoids routing/pool accounts and
      // ensures we pick the true trade mint and delta for this wallet.
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
      // Legacy behavior: aggregate deltas across all accounts in the
      // transaction. This is preserved for callers that do not provide a
      // walletAddress and want a coarse view of flows.
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

      // Any remaining pre balances that disappeared entirely become pure negatives.
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

    // Select candidate mints based on wallet-scoped deltas, but skip numeraires
    // like SOL/USDC since we want the "asset" side of the trade (e.g. pippin),
    // not the base currency.
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
    let tokenDelta = 0;

    if (solSpent > 0 && outputMint && outputDelta > MINIMUM_DELTA_THRESHOLD) {
      // Typical BUY: spend SOL, receive SPL tokens.
      tokenDelta = outputDelta;
      priceSolPerToken = solSpent / tokenDelta;
      chosenMint = outputMint;
      chosenDecimals = decimalsByMint.get(outputMint) || 0;
    } else if (
      solReceived > 0 &&
      inputMint &&
      inputDelta > MINIMUM_DELTA_THRESHOLD
    ) {
      // Typical SELL: spend SPL tokens, receive SOL.
      tokenDelta = inputDelta;
      priceSolPerToken = solReceived / tokenDelta;
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
      return null;
    }

    const mintLabel = chosenMint ? MINT_LABELS[chosenMint] || chosenMint : '?';
    logger.info(
      `[txInsightService] Recovered price for ${txid}: ${priceSolPerToken} SOL per unit of ${mintLabel}`
    );

    return {
      priceSolPerToken,
      tokenDelta,
      solDelta: solDeltaLamports / 1e9,
      mint: chosenMint,
      decimals: chosenDecimals,
    };
  } catch (err) {
    logger.error(
      `[txInsightService] Error parsing transaction ${txid}: ${err.message}`
    );
    return null;
  }
}

module.exports = {
  recoverPriceFromTransactionv2,
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
};
