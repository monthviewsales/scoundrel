'use strict';

/**
 * Extract a numeric timestamp from heterogeneous trade payloads.
 * @param {any} trade
 * @returns {number|null}
 */
function extractTimestamp(trade) {
  if (!trade) return null;
  const candidates = [
    trade.blockTime,
    trade.block_time,
    trade.timestamp,
    trade.time,
    trade.ts,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * Bind helper fetching wallet trades with cursor pagination and optional time/window trimming.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function, log: { debug: Function } }} deps
 * @returns {(options: { wallet: string, limit?: number, startTime?: number, endTime?: number, parseJupiter?: boolean, hideArb?: boolean, showMeta?: boolean }) => Promise<any[]>}
 */
function createGetWalletTrades({ client, call, log }) {
  if (!client || !call) throw new Error('createGetWalletTrades: missing dependencies');

  return async function getWalletTrades({
    wallet,
    limit = 500,
    startTime,
    endTime,
    parseJupiter = true,
    hideArb = true,
    showMeta = false,
  } = {}) {
    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new Error('getWalletTrades: wallet is required');
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('getWalletTrades: limit must be a positive integer');
    }
    const owner = wallet.trim();
    const trades = [];
    let cursor;

    while (trades.length < limit) {
      // eslint-disable-next-line no-await-in-loop
      const page = await call('getWalletTrades', () => client.getWalletTrades(
        owner,
        cursor,
        showMeta,
        parseJupiter,
        hideArb,
      ));

      const pageTrades = Array.isArray(page?.trades)
        ? page.trades
        : Array.isArray(page)
          ? page
          : [];
      trades.push(...pageTrades);
      log?.debug('getWalletTrades page', { count: pageTrades.length, total: trades.length });

      if (!page?.hasNextPage || !page?.nextCursor) break;
      cursor = page.nextCursor;
    }

    const sliced = trades.slice(0, limit);

    if (startTime == null && endTime == null) {
      return sliced;
    }

    return sliced.filter((trade) => {
      const ts = extractTimestamp(trade);
      if (!Number.isFinite(ts)) return true;
      if (startTime != null && ts < startTime) return false;
      if (endTime != null && ts > endTime) return false;
      return true;
    });
  };
}

module.exports = { createGetWalletTrades };
