"use strict";

const { createSolanaTrackerDataClient } = require("../../../solanaTrackerDataClient");
const { ensureTokenInfo } = require("../../../services/tokenInfoService");
const {
  buildTxDisplay,
  mapCoinMeta,
} = require("../warchestServiceHelpers");

const DEFAULT_COIN_CACHE_MAX_AGE_MS = 60_000;

/**
 * Create a HUD transaction feed manager that normalizes hub events and enriches
 * them with token metadata.
 *
 * @param {Object} [options]
 * @param {number} [options.maxItems=10] - Max number of transactions to keep in the feed.
 * @param {Object} [options.logger] - Logger for warnings.
 * @param {Object} [options.dataLogger] - Logger for Data API calls.
 * @param {Function} [options.emitChange] - Callback invoked when the feed updates.
 * @returns {{ingestEvents: Function, getFeed: Function}}
 */
function createHudTxFeed(options = {}) {
  const maxItems = Number.isFinite(Number(options.maxItems)) && Number(options.maxItems) > 0
    ? Math.trunc(Number(options.maxItems))
    : 10;
  const logger = options.logger || null;
  const emitChange = typeof options.emitChange === "function" ? options.emitChange : () => {};
  const dataLogger = options.dataLogger || logger || undefined;

  const dataClient = createSolanaTrackerDataClient({
    logger: dataLogger,
  });

  const coinCache = new Map();
  const txFeed = [];
  const txFeedById = new Map();

  async function fetchCoinMeta(mint) {
    if (!mint) return null;
    const cached = coinCache.get(mint);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < DEFAULT_COIN_CACHE_MAX_AGE_MS) {
      return cached.data;
    }

    try {
      const info = await ensureTokenInfo({
        mint,
        client: dataClient,
        forceRefresh: false,
      });
      if (info) {
        coinCache.set(mint, { data: info, fetchedAt: now });
        return info;
      }
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      if (logger && typeof logger.warn === "function") {
        logger.warn(`[HUD] token info fetch failed for ${mint}: ${msg}`);
      }
    }

    return cached ? cached.data : null;
  }

  /**
   * Ingest hub events into the HUD tx feed.
   *
   * @param {Array} events
   * @returns {Promise<void>}
   */
  async function ingestEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;

    const tsOf = (ev) => {
      if (!ev) return 0;

      const ts =
        ev.txSummary?.blockTimeIso ||
        ev.blockTimeIso ||
        ev.txSummary?.observedAt ||
        ev.observedAt ||
        null;

      const ms = ts ? Date.parse(ts) : null;
      return Number.isFinite(ms) ? ms : 0;
    };

    const isDustTx = (entry) => {
      if (!entry) return true;

      const hasAmounts =
        (entry.sol != null &&
          Number.isFinite(Number(entry.sol)) &&
          Math.abs(Number(entry.sol)) > 0) ||
        (entry.tokens != null &&
          Number.isFinite(Number(entry.tokens)) &&
          Math.abs(Number(entry.tokens)) > 0);

      if (!entry.mint && !entry.side && !hasAmounts) return true;

      if (
        !entry.side &&
        entry.sol != null &&
        Number.isFinite(Number(entry.sol)) &&
        Math.abs(Number(entry.sol)) < 0.00001
      ) {
        return true;
      }

      if (
        !entry.side &&
        entry.tokens != null &&
        Number.isFinite(Number(entry.tokens)) &&
        Math.abs(Number(entry.tokens)) < 0.0001
      ) {
        return true;
      }

      return false;
    };

    const recent = events
      .slice(0)
      .sort((a, b) => {
        const at = tsOf(a);
        const bt = tsOf(b);
        if (bt !== at) return bt - at;

        const aid = (a && (a.txid || a.txSummary?.txid)) || "";
        const bid = (b && (b.txid || b.txSummary?.txid)) || "";
        return bid.localeCompare(aid);
      })
      .slice(0, maxItems);

    const nextFeed = [];

    for (const ev of recent) {
      const txid = (ev && (ev.txid || ev.txSummary?.txid)) || null;
      if (!txid) continue;

      const prev = txFeedById.get(txid) || null;
      const entry = buildTxDisplay(ev, prev);
      if (!entry) continue;

      if (isDustTx(entry)) continue;

      if (
        !Number.isFinite(Number(entry.observedAt)) ||
        Number(entry.observedAt) <= 0
      ) {
        entry.observedAt = prev?.observedAt ?? tsOf(ev) ?? 0;
      }

      if (prev && prev.coin && !entry.coin) {
        entry.coin = prev.coin;
      }

      txFeedById.set(txid, entry);
      nextFeed.push(entry);
    }

    txFeed.length = 0;
    for (const entry of nextFeed) txFeed.push(entry);

    for (const entry of nextFeed) {
      if (!entry || !entry.mint || entry.coin) continue;
      fetchCoinMeta(entry.mint)
        .then((info) => {
          const mapped = mapCoinMeta(info);
          if (!mapped) return;
          const current = txFeedById.get(entry.txid);
          if (!current) return;
          if (!current.coin) {
            current.coin = mapped;
            emitChange();
          }
        })
        .catch(() => {});
    }

    emitChange();
  }

  function getFeed() {
    return txFeed.slice(0, maxItems);
  }

  return { ingestEvents, getFeed };
}

module.exports = { createHudTxFeed };
