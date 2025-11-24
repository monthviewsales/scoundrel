const { scanWalletViaRpc } = require("./WalletScanner");
const logger = require("../lib/logger");
const BootyBox = require("./packages/bootybox");
const { address } = require("@solana/addresses");
const PnLUtils = require("./PnLUtils");
const {
  recoverPriceFromTransactionv2,
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
} = require("./services/txInsightService");

const STABLECOIN_MAP = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const NON_TRADABLE_MINTS = new Set(Object.values(STABLECOIN_MAP));

const MINT_LABELS = Object.freeze({
  [STABLECOIN_MAP.SOL]: "SOL",
  [STABLECOIN_MAP.USDC]: "USDC",
});

function isNonTradableMint(mint) {
  return Boolean(mint) && NON_TRADABLE_MINTS.has(mint);
}

function lamportsToSol(lamports) {
  const lamportsNumber = Number(lamports);
  if (!Number.isFinite(lamportsNumber)) {
    throw new Error("lamports value is not a finite number");
  }
  return lamportsNumber / 1e9;
}

/**
 * @class WalletManager
 * @description
 * Responsible for managing and caching wallet balances, interacting with Solana APIs to retrieve
 * coin balances for specific coin mints, and syncing with BootyBox to track currently held positions.
 */
class WalletManager {
  /**
   * @constructor
   * @param {Object} connection - Solana connection object.
   * @param {string} privateKey - Private key for the wallet.
   * @param {Object} keypair - Solana keypair object.
   * @param {Object} rpcEndpoint - Pre-instantiated SolanaTracker RPC client.
   */
  constructor(
    connection,
    privateKey,
    keypair,
    publicKeyb58,
    walletCacheTTL = 120000,
    rpcEndpoint = null
  ) {
    this.connection = connection;
    this.privateKey = privateKey;
    this.keypair = keypair;
    this.publicKeyb58 = publicKeyb58;
    this.walletAmountCache = new Map();
    this.walletCacheTTL = walletCacheTTL;
    this.rpc = rpcEndpoint; // now treated as a pre-built RPC client instance
    if (!this.rpc) {
      throw new Error(
        "[WalletManager] RPC client is required (pass instantiated client as rpcEndpoint)."
      );
    }
    this.ownerAddress = address(this.publicKeyb58);

    this._resyncTimer = null;
    logger.info(
      `[WalletManager] Initialized with publicKey: ${this.publicKeyb58}`
    );
  }

  /**
   * Resolves the highest price for a given mint.
   * Keeps existing highestPrice if present, otherwise falls back to entryPrice.
   * @param {string} mint - The token mint address.
   * @returns {number} - The resolved highest price.
   */
  async resolveHighestPrice(mint, entryPrice) {
    const existing = await BootyBox.getBootyByMint(mint);
    return existing ? existing.highestPrice : entryPrice;
  }

  /**
   * Refreshes the wallet amount cache for all currently held coin positions in BootyBox.
   * @returns {Promise<void>}
   */
  async updatePositionWalletCache() {
    const openPositions = await BootyBox.getOpenPositions();
    for (const position of openPositions) {
      await this.getWalletAmtViaRpc(position.coin_mint);
    }
    logger.debug(
      "[WalletManager] Cache updated for all held positions from BootyBox"
    );
  }

  /**
   * Resyncs wallet tokens using raw RPC via WalletScanner, bypassing SolanaTracker.
   * Populates BootyBox with live on-chain token balances.
   * @returns {Promise<void>}
   */
  async resyncWalletTokensViaRpc() {
    if (this._resyncInProgress) {
      logger.info(
        "[WalletManager] resync already in progress; skipping concurrent call"
      );
      return [];
    }
    this._resyncInProgress = true;
    try {
      // NOTE: WalletScanner currently expects a Kit RPC; we keep this.rpc for now.
      const walletTokens = await scanWalletViaRpc(this.rpc, this.publicKeyb58);
      const positions = [];
      const now = Date.now();
      const solUsdPrice = await PnLUtils.getCurrentSolPrice();

      for (const walletToken of walletTokens) {
        const { mint, amount, decimals, symbol } = walletToken || {};
        if (!mint || !Number.isFinite(amount) || amount <= 0) continue;
        logger.debug(
          `[WalletManager] Raw wallet amount for ${mint}: ${amount} (decimals=${
            decimals ?? "n/a"
          })`
        );

        if (isNonTradableMint(mint)) {
          const label = MINT_LABELS[mint] || mint;
          logger.debug(
            `[WalletManager] Skipping ${label} — managed separately`
          );
          continue;
        }

        const existingPosition = await BootyBox.getBootyByMint(mint);
        let entryPriceSOL = existingPosition?.entryPrice || 0;
        let entryPriceUSD = existingPosition?.entryPriceUSD || 0;
        let tradeUuid = existingPosition?.trade_uuid || null;

        let coinRecord = await BootyBox.getCoinByMint(mint);
        if (!coinRecord) {
          await BootyBox.addOrUpdateCoin({
            mint,
            symbol: symbol || null,
            decimals: Number.isFinite(decimals) ? decimals : 0,
            status: "complete",
            lastUpdated: now,
          });
          coinRecord = await BootyBox.getCoinByMint(mint);
        }

        const latestBuy = await BootyBox.getLatestBuyByMint(mint);
        if (!entryPriceUSD && latestBuy) {
          entryPriceUSD = Number(latestBuy.priceUsd) || 0;
          entryPriceSOL = Number(latestBuy.price) || entryPriceSOL;
          tradeUuid = tradeUuid || latestBuy.trade_uuid || null;
        }

        if (!entryPriceUSD) {
          entryPriceUSD =
            (await recoverEntryPriceFromHistory(mint, this.publicKeyb58)) || 0;
        }

        if (!entryPriceSOL && entryPriceUSD > 0) {
          entryPriceSOL = entryPriceUSD / solUsdPrice;
        }

        const normalizedAmount = amount;
        const positionValue =
          entryPriceUSD > 0
            ? normalizedAmount * entryPriceUSD
            : normalizedAmount;
        if (entryPriceUSD > 0 && positionValue < 0.01) {
          logger.debug(
            `[WalletManager] Skipping ${mint} — value too small ($${positionValue.toFixed(
              6
            )})`
          );
          continue;
        }

        const trailingStop = parseFloat(
          process.env.TRAILING_STOP_PERCENT || "0.05"
        );
        const highest = await this.resolveHighestPrice(mint, entryPriceSOL);

        const priceUsdSnapshot =
          coinRecord?.price && coinRecord.price > 0
            ? coinRecord.price
            : entryPriceUSD;

        if (coinRecord) {
          await BootyBox.addOrUpdateCoin({
            mint,
            symbol: coinRecord.symbol || symbol || null,
            decimals:
              coinRecord.decimals ?? (Number.isFinite(decimals) ? decimals : 0),
            status: "complete",
            price: priceUsdSnapshot || 0,
            lastUpdated: now,
          });
        }

        positions.push({
          coin_mint: mint,
          amount: normalizedAmount,
          entryPrice: entryPriceSOL,
          entryPriceUSD: entryPriceUSD,
          highestPrice: highest,
          sl:
            entryPriceSOL > 0
              ? entryPriceSOL * (1 - trailingStop)
              : existingPosition?.sl ?? 0,
          trade_uuid: tradeUuid || null,
          timestamp: now,
          lastValidated: now,
        });
      }

      await BootyBox.bulkResyncPositions(positions);
      logger.info(
        `[WalletManager] Wallet tokens resynced via transactional upsert (${positions.length} positions)`
      );
      return positions;
    } catch (err) {
      logger.error(`❌ [WalletManager] Failed RPC resync: ${err.message}`);
      throw err;
    } finally {
      this._resyncInProgress = false;
    }
  }

  /**
   * Indicates whether a wallet resync is currently in progress.
   * @returns {boolean}
   */
  isResyncInProgress() {
    return !!this._resyncInProgress;
  }

  /**
   * Retrieves wallet balance for a specific mint using direct RPC.
   * Caches the result for walletCacheTTL ms.
   * @param {string} mint - Mint address to check.
   * @returns {Promise<number|null>} - Token balance or null.
   */
  async getWalletAmtViaRpc(mint, options = {}) {
    const { bypassCache = false } = options || {};
    const now = Date.now();
    const cached = this.walletAmountCache.get(mint);
    if (
      !bypassCache &&
      cached &&
      now - cached.timestamp < this.walletCacheTTL
    ) {
      return cached.amount;
    }

    try {
      if (mint === STABLECOIN_MAP.SOL) {
        const { value: lamports } = await this.rpc
          .getBalance(this.ownerAddress, { commitment: "confirmed" })
          .send();
        const solAmount = lamportsToSol(lamports);
        this.walletAmountCache.set(mint, {
          amount: solAmount,
          timestamp: Date.now(),
        });
        return solAmount;
      }

      let mintAddress;
      try {
        mintAddress = address(mint);
      } catch (err) {
        logger.error(
          `[WalletManager] Invalid mint for RPC lookup: ${mint} — ${err.message}`
        );
        return null;
      }

      const { value: tokenAccounts } = await this.rpc
        .getTokenAccountsByOwner(
          this.ownerAddress,
          { mint: mintAddress },
          { encoding: "jsonParsed", commitment: "confirmed" }
        )
        .send();

      const firstAccount = tokenAccounts?.[0]?.account?.data?.parsed?.info;
      if (firstAccount) {
        const amtStr =
          firstAccount.tokenAmount?.uiAmountString ??
          String(firstAccount.tokenAmount?.uiAmount ?? "0");
        const amount = Number.parseFloat(amtStr);
        this.walletAmountCache.set(mint, { amount, timestamp: now });
        return amount;
      }

      this.walletAmountCache.set(mint, { amount: 0, timestamp: now });
      logger.warn(`[WalletManager] [RPC] No token account found for ${mint}`);
    } catch (err) {
      logger.error(
        `❌ [WalletManager] [RPC] Error fetching balance for ${mint}: ${err.message}`
      );
    }
    return null;
  }

  /**
   * Retrieves and emits the current SOL balance to the bot immediately.
   * Useful for frequent balance checks without full mint lookup.
   * @returns {Promise<number|null>} - SOL balance in SOL (not lamports)
   */
  async broadcastSolBalance(options = {}) {
    const { bypassCache = true } = options || {};
    try {
      let solAmount = await this.getWalletAmtViaRpc(STABLECOIN_MAP.SOL, { bypassCache });
      if (!Number.isFinite(solAmount)) {
        const cached = this.walletAmountCache.get(STABLECOIN_MAP.SOL);
        if (cached && Number.isFinite(cached.amount)) {
          solAmount = cached.amount;
        }
      }
      if (!Number.isFinite(solAmount)) {
        logger.warn("[WalletManager] SOL balance unavailable for broadcast.");
        return null;
      }
      logger.debug(`[WalletManager] Current SOL balance: ${solAmount}`);
      global.bot?.emit("solBalance", solAmount);
      return solAmount;
    } catch (err) {
      logger.error(
        `❌ [WalletManager] Failed to broadcast SOL balance: ${err.message}`
      );
      return null;
    }
  }

  /**
   * Retrieves and emits the current USDC balance to the bot.
   * @param {Object} [options]
   * @param {boolean} [options.bypassCache=true] - When true, forces a fresh RPC fetch.
   * @returns {Promise<number|null>} - USDC token balance.
   */
  async broadcastUsdcBalance(options = {}) {
    const { bypassCache = true } = options || {};
    try {
      let usdcAmount = await this.getWalletAmtViaRpc(STABLECOIN_MAP.USDC, {
        bypassCache,
      });
      if (!Number.isFinite(usdcAmount)) {
        const cached = this.walletAmountCache.get(STABLECOIN_MAP.USDC);
        if (cached && Number.isFinite(cached.amount)) {
          usdcAmount = cached.amount;
        }
      }
      if (!Number.isFinite(usdcAmount)) {
        logger.warn("[WalletManager] USDC balance unavailable for broadcast.");
        return null;
      }
      logger.debug(`[WalletManager] Current USDC balance: ${usdcAmount}`);
      global.bot?.emit("usdcBalance", usdcAmount);
      return usdcAmount;
    } catch (err) {
      logger.error(
        `❌ [WalletManager] Failed to broadcast USDC balance: ${err.message}`
      );
      return null;
    }
  }
}

module.exports = WalletManager;

/**
 * Verifies a completed swap by comparing actual transaction data to BootyBox records.
 * Logs any discrepancies found and, when necessary, writes a corrective position back
 * into BootyBox based on on-chain balances and recovered pricing information.
 *
 * @param {string} txid - The swap transaction ID.
 * @param {string} mint - The token mint involved.
 * @param {boolean} isBuy - Whether this was a buy or a sell.
 */
WalletManager.prototype.verifyAndCorrectPosition = async function (
  txid,
  mint,
  isBuy
) {
  logger.info(
    `[WalletManager] Verifying swap for ${mint} from txid ${txid}...`
  );

  const position = await BootyBox.getBootyByMint(mint);
  if (!position) {
    logger.warn(
      `[WalletManager] No position found in BootyBox for ${mint}. Skipping verification.`
    );
    return;
  }

  const priceInfo = await recoverPriceFromTransactionv2(txid);
  const priceFromTx = priceInfo?.priceSolPerToken ?? null;
  if (!priceFromTx) {
    logger.warn(
      `[WalletManager] Unable to recover price from txid ${txid} for ${mint}.`
    );
    return;
  }

  const actualQty = await this.getWalletAmtViaRpc(mint);
  if (actualQty === null) {
    logger.warn(
      `[WalletManager] Failed to fetch actual wallet amount for ${mint}.`
    );
    return;
  }

  const cachedAmount = position.amount;
  const cachedPrice = isBuy ? position.entryPrice : position.exitPrice ?? "N/A";

  const deltaQty = Math.abs(cachedAmount - actualQty);
  const deltaPrice = isBuy ? Math.abs(cachedPrice - priceFromTx) : 0;

  logger.debug(`[WalletManager] Position check for ${mint}:`);
  logger.debug(`   Cached amount: ${cachedAmount}`);
  logger.debug(`   Actual amount: ${actualQty}`);
  logger.debug(`   Δ Amount: ${deltaQty}`);

  if (isBuy) {
    logger.debug(`   Cached entry price: ${cachedPrice}`);
    logger.debug(`   Price from tx: ${priceFromTx}`);
    logger.debug(`   Δ Price: ${deltaPrice}`);
  }

  if (deltaQty > 0.000001 || deltaPrice > 0.000001) {
    logger.warn(`[WalletManager] 🔎 Discrepancy detected for ${mint}:`);
    if (deltaQty > 0.000001) {
      logger.warn(
        `   → Amount mismatch: cached=${cachedAmount} vs actual=${actualQty}`
      );
    }
    if (isBuy && deltaPrice > 0.000001) {
      logger.warn(
        `   → Entry price mismatch: cached=${cachedPrice} vs tx=${priceFromTx}`
      );
    }

    const solUsdPrice = await PnLUtils.getCurrentSolPrice();
    const entryPriceUSD = priceFromTx * solUsdPrice;
    const correctionPayload = {
      coin_mint: mint,
      amount: actualQty,
      highestPrice: Math.max(position.highestPrice || 0, priceFromTx),
      trade_uuid: position.trade_uuid || BootyBox.getTradeUuid?.(mint) || null,
      sl: position.sl,
      timestamp: Date.now(),
      lastValidated: Date.now(),
    };
    if (isBuy) {
      correctionPayload.entryPrice = priceFromTx;
      correctionPayload.entryPriceUSD = entryPriceUSD;
    }
    await BootyBox.addPosition(correctionPayload);
    logger.info(
      `[WalletManager] ✅ Corrected BootyBox position for ${mint} using RPC balances.`
    );
  } else {
    logger.info(
      `[WalletManager] ✅ Position for ${mint} matches actual swap data.`
    );
  }
};
