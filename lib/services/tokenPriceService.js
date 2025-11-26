

'use strict';

const BootyBox = require('../../packages/bootybox');
const log = require('../log');
const { ensureTokenInfo } = require('./tokenInfoService');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');

/**
 * @typedef {Object} CoinPriceSnapshot
 * @property {string} mint
 * @property {string|null} symbol
 * @property {string|null} name
 * @property {number|null} decimals
 * @property {number|null} priceUsd
 * @property {number|null} liquidityUsd
 * @property {number|null} marketCapUsd
 * @property {number|null} buyScore
 * @property {number|null} lastUpdated
 * @property {object|null} coinRow
 * @property {object|null} rawInfo
 */

/**
 * @typedef {Object} HealMintAndPositionParams
 * @property {string} wallet - Solana wallet address (base58).
 * @property {string} mint - Token mint address.
 * @property {number} [currentAmount] - Optional current token amount (human-readable units) from RPC.
 * @property {boolean} [force] - If true, forces re-hydration even if a position already exists.
 */

/**
 * Factory for token price / position healing utilities.
 *
 * This service is intended to be the single place where we:
 *   - Ensure a coin row exists in BootyBox.coins for a given mint.
 *   - Keep that row populated with metadata and price from SolanaTracker Data API.
 *   - Recreate a position row in BootyBox.positions when Scoundrel discovers
 *     an on-chain balance that was acquired outside of Scoundrel.
 *
 * It is deliberately conservative: it prefers existing DB data when present,
 * uses the Data API to fill in missing gaps, and avoids overwriting good DB
 * rows with obviously empty/garbage API payloads (the metadata part is handled
 * by tokenInfoService/BootyBox).
 *
 * @param {object} [options]
 * @param {import('@solana-tracker/data-api').Client} [options.client]
 * @param {() => number} [options.now] - Clock function, overridable for tests.
 * @returns {{ ensureCoinAndPriceForMint: (params: { mint: string, force?: boolean }) => Promise<CoinPriceSnapshot>, healMintAndPosition: (params: HealMintAndPositionParams) => Promise<object|null> }}
 */
function createTokenPriceService(options = {}) {
  const {
    client = createSolanaTrackerDataClient(),
    now = () => Date.now(),
  } = options;

  if (!client || typeof client.getTokenInformation !== 'function') {
    throw new Error(
      '[tokenPriceService] SolanaTracker Data API client with getTokenInformation is required',
    );
  }

  /**
   * Best-effort extraction of a USD price, liquidity, and market cap from a
   * SolanaTracker token information payload or a BootyBox coin row.
   *
   * @param {object|null} coinRow - Row from BootyBox.coins, if available.
   * @param {object|null} info - Raw payload returned from getTokenInformation, if available.
   * @returns {{ priceUsd: number|null, liquidityUsd: number|null, marketCapUsd: number|null, buyScore: number|null, lastUpdated: number|null }}
   */
  function extractPriceFields(coinRow, info) {
    let priceUsd = null;
    let liquidityUsd = null;
    let marketCapUsd = null;
    let buyScore = null;
    let lastUpdated = null;

    if (coinRow) {
      const p = Number(coinRow.price);
      if (Number.isFinite(p) && p > 0) {
        priceUsd = p;
      }
      const l = Number(coinRow.liquidity);
      if (Number.isFinite(l) && l >= 0) {
        liquidityUsd = l;
      }
      const mc = Number(coinRow.marketCap);
      if (Number.isFinite(mc) && mc >= 0) {
        marketCapUsd = mc;
      }
      const bs = coinRow.buyScore != null ? Number(coinRow.buyScore) : null;
      if (Number.isFinite(bs)) {
        buyScore = bs;
      }
      const ts = Number(coinRow.lastUpdated);
      if (Number.isFinite(ts) && ts > 0) {
        lastUpdated = ts;
      }
    }

    // Fill from raw API info if DB is missing some fields.
    if (info) {
      const token = info.token || info;
      const pool = Array.isArray(info.pools) && info.pools.length > 0 ? info.pools[0] : null;

      // Price
      if (priceUsd == null) {
        if (token && token.price != null) {
          const p = Number(token.price);
          if (Number.isFinite(p) && p > 0) priceUsd = p;
        }
        if (priceUsd == null && token && token.priceUsd != null) {
          const p = Number(token.priceUsd);
          if (Number.isFinite(p) && p > 0) priceUsd = p;
        }
        if (priceUsd == null && token && token.price_usd != null) {
          const p = Number(token.price_usd);
          if (Number.isFinite(p) && p > 0) priceUsd = p;
        }
        if (priceUsd == null && pool && pool.price && typeof pool.price === 'object') {
          const p = Number(pool.price.usd ?? pool.price.USD);
          if (Number.isFinite(p) && p > 0) priceUsd = p;
        }
      }

      // Liquidity
      if (liquidityUsd == null && pool && pool.liquidity != null) {
        const l = typeof pool.liquidity === 'object'
          ? Number(pool.liquidity.usd ?? pool.liquidity.USD)
          : Number(pool.liquidity);
        if (Number.isFinite(l) && l >= 0) {
          liquidityUsd = l;
        }
      }

      // Market cap
      if (marketCapUsd == null && pool && pool.marketCap != null) {
        const mc = typeof pool.marketCap === 'object'
          ? Number(pool.marketCap.usd ?? pool.marketCap.USD)
          : Number(pool.marketCap);
        if (Number.isFinite(mc) && mc >= 0) {
          marketCapUsd = mc;
        }
      }

      // Buy score if exposed by API (naming may vary; keep this flexible).
      if (buyScore == null && token && token.buyScore != null) {
        const bs = Number(token.buyScore);
        if (Number.isFinite(bs)) buyScore = bs;
      }
    }

    return {
      priceUsd,
      liquidityUsd,
      marketCapUsd,
      buyScore,
      lastUpdated,
    };
  }

  /**
   * Ensure that we have an up-to-date coin row for the given mint and return
   * a snapshot of its metadata + price fields for use in HUDs and jobs.
   *
   * This always delegates to tokenInfoService.ensureTokenInfo, which:
   *   - checks BootyBox.coins for an existing row
   *   - calls SolanaTracker Data API getTokenInformation when needed
   *   - upserts the coins table with any meaningful metadata/price fields
   *
   * @param {{ mint: string, force?: boolean }} params
   * @returns {Promise<CoinPriceSnapshot>}
   */
  async function ensureCoinAndPriceForMint({ mint, force = false }) {
    if (!mint || typeof mint !== 'string') {
      throw new Error('[tokenPriceService.ensureCoinAndPriceForMint] mint is required');
    }

    await BootyBox.init();

    let info = null;
    try {
      // tokenInfoService will decide whether to hit the Data API based on DB state.
      info = await ensureTokenInfo({ mint, client });
    } catch (err) {
      log.warn(
        '[tokenPriceService.ensureCoinAndPriceForMint] ensureTokenInfo failed',
        err?.message || err,
      );
    }

    let coinRow = null;
    try {
      // Refresh our normalized coin view after ensureTokenInfo has had a chance to upsert.
      // If ensureTokenInfo failed or returned null, this may still be null.
      // That is OK; we will fall back to the raw info payload where possible.
      // @ts-ignore BootyBox is a JS module
      coinRow = await BootyBox.getCoinByMint(mint);
    } catch (err) {
      log.warn(
        '[tokenPriceService.ensureCoinAndPriceForMint] getCoinByMint failed',
        err?.message || err,
      );
    }

    const token = info && (info.token || info) || {};

    const symbol = (coinRow && coinRow.symbol) || token.symbol || null;
    const name = (coinRow && coinRow.name) || token.name || null;
    const decimals =
      coinRow && typeof coinRow.decimals === 'number'
        ? coinRow.decimals
        : typeof token.decimals === 'number'
          ? token.decimals
          : null;

    const priceFields = extractPriceFields(coinRow, info);

    /** @type {CoinPriceSnapshot} */
    const snapshot = {
      mint,
      symbol: symbol != null ? String(symbol) : null,
      name: name != null ? String(name) : null,
      decimals: decimals != null ? Number(decimals) : null,
      priceUsd: priceFields.priceUsd,
      liquidityUsd: priceFields.liquidityUsd,
      marketCapUsd: priceFields.marketCapUsd,
      buyScore: priceFields.buyScore,
      lastUpdated: priceFields.lastUpdated,
      coinRow: coinRow || null,
      rawInfo: info || null,
    };

    return snapshot;
  }

  /**
   * Best-effort healer for a given wallet+mint combination.
   *
   * This is intended for scenarios where Scoundrel discovers that a wallet
   * holds a non-stablecoin balance (e.g. via RPC) but there is no corresponding
   * position row in BootyBox.positions because the buys happened "offline"
   * (outside of Scoundrel).
   *
   * Flow:
   *   1. Check for an existing position via BootyBox.getBootyByMint(mint).
   *   2. If missing or force=true:
   *      a. Ensure coin metadata/price via ensureCoinAndPriceForMint.
   *      b. Use SolanaTracker Data API (getUserTokenTrades) and/or the
   *         currentAmount hint to infer the net position size and an
   *         approximate entry price/timestamp.
   *      c. Persist a new position row via BootyBox.addPosition.
   *   3. Return the refreshed BootyBox.getBootyByMint(mint) row (or null if
   *      we still cannot infer a valid position).
   *
   * NOTE: We intentionally do NOT auto-create positions for known stables
   * (USDC/USDT/USD1). They should be tracked as balances only.
   *
   * @param {HealMintAndPositionParams} params
   * @returns {Promise<object|null>} Joined BootyBox.getBootyByMint(mint) row, or null if we can't build one.
   */
  async function healMintAndPosition({ wallet, mint, currentAmount, force = false }) {
    if (!wallet || typeof wallet !== 'string') {
      throw new Error('[tokenPriceService.healMintAndPosition] wallet (base58 string) is required');
    }
    if (!mint || typeof mint !== 'string') {
      throw new Error('[tokenPriceService.healMintAndPosition] mint is required');
    }

    await BootyBox.init();

    let existing = null;
    try {
      // @ts-ignore BootyBox is a JS module
      existing = await BootyBox.getBootyByMint(mint);
    } catch (err) {
      log.warn(
        '[tokenPriceService.healMintAndPosition] getBootyByMint failed',
        err?.message || err,
      );
    }

    if (existing && !force) {
      return existing;
    }

    // Skip auto-creating positions for known stables.
    // NOTE: this duplicates the list in warchestHudWorker; consider centralizing.
    const STABLE_MINTS = new Set([
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkZwyTDt1v', // USDC
      'Es9vMFrzaCERkVbB6w6jQ3z6rj4MZkHc6hZ8Qx1iGvQe', // USDT
      'USD1',
    ]);
    if (STABLE_MINTS.has(mint)) {
      return null;
    }

    // 1. Ensure coin metadata and price.
    let snapshot = null;
    try {
      snapshot = await ensureCoinAndPriceForMint({ mint });
    } catch (err) {
      log.warn(
        '[tokenPriceService.healMintAndPosition] ensureCoinAndPriceForMint failed',
        err?.message || err,
      );
    }

    // 2. Try to reconstruct position from trades via Data API.
    let trades = [];
    try {
      if (wallet && mint) {
        trades = await client.getUserTokenTrades(mint, wallet);
      }
    } catch (err) {
      log.warn(
        '[tokenPriceService.healMintAndPosition] getUserTokenTrades failed',
        err?.message || err,
      );
    }

    // 3. Infer position: sum net amount, estimate entry price/timestamp.
    let netAmount = 0;
    let entryPrice = null;
    let entryTimestamp = null;
    if (Array.isArray(trades) && trades.length > 0) {
      for (const t of trades) {
        const amt = Number(t.amount);
        if (Number.isFinite(amt)) {
          netAmount += amt;
        }
      }
      // Try to estimate entry price from the first buy trade.
      const firstBuy = trades.find(t => Number(t.amount) > 0);
      if (firstBuy) {
        entryPrice = Number(firstBuy.price);
        entryTimestamp = Number(firstBuy.timestamp || firstBuy.blockTime || firstBuy.time);
      }
    }
    // If currentAmount is provided and nonzero, prefer it over netAmount.
    if (typeof currentAmount === 'number' && Number.isFinite(currentAmount) && currentAmount > 0) {
      netAmount = currentAmount;
    }

    if (!(netAmount > 0)) {
      // No position to heal.
      return null;
    }

    // 4. Add position to BootyBox.
    let position = null;
    try {
      // @ts-ignore BootyBox is a JS module
      await BootyBox.addPosition({
        mint,
        coin_mint: mint,
        amount: netAmount,
        entryPrice: entryPrice != null ? entryPrice : snapshot?.priceUsd,
        entryTimestamp: entryTimestamp != null ? entryTimestamp : now(),
        wallet,
        // Add more fields if needed.
      });
      position = await BootyBox.getBootyByMint(mint);
    } catch (err) {
      log.warn(
        '[tokenPriceService.healMintAndPosition] addPosition/getBootyByMint failed',
        err?.message || err,
      );
    }
    return position || null;
  }

  return {
    ensureCoinAndPriceForMint,
    healMintAndPosition,
  };
}

module.exports = {
  createTokenPriceService,
};
