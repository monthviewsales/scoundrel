'use strict';

/**
 * Parse a numeric candidate value.
 * @param {any} value
 * @returns {number|null}
 */
function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Extract a timestamp from a trade.
 * @param {Object} trade
 * @returns {number|null}
 */
function extractTimestamp(trade) {
  if (!trade) return null;
  const candidates = [trade.blockTime, trade.block_time, trade.timestamp, trade.time, trade.ts];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return null;
}

/**
 * Extract side (buy/sell) from a trade.
 * @param {Object} trade
 * @param {string} wallet
 * @returns {string|null}
 */
function extractSide(trade, wallet) {
  if (!trade) return null;
  if (typeof trade.type === 'string') {
    const t = trade.type.toLowerCase();
    if (t === 'buy' || t === 'sell') return t;
  }
  if (typeof trade.side === 'string') return trade.side.toLowerCase();
  if (trade.direction) return String(trade.direction).toLowerCase();
  if (trade.from && trade.from.address === wallet) return 'sell';
  if (trade.to && trade.to.address === wallet) return 'buy';
  return null;
}

/**
 * Extract amount from a trade.
 * @param {Object} trade
 * @returns {number|null}
 */
function extractAmount(trade) {
  if (!trade) return null;
  const candidates = [trade.amount, trade.tokenAmount, trade.quantity, trade.size, trade.volume?.token, trade.volume?.amount];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return null;
}

/**
 * Extract price from a trade.
 * @param {Object} trade
 * @returns {number|null}
 */
function extractPrice(trade) {
  if (!trade) return null;
  const candidates = [trade.priceUsd, trade.price_usd, trade.price?.usd, trade.price?.sol, trade.price, trade.executionPrice];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return null;
}

/**
 * Extract fees from a trade.
 * @param {Object} trade
 * @returns {number}
 */
function extractFees(trade) {
  if (!trade) return 0;
  const candidates = [trade.fee, trade.fees, trade.feePaid, trade.feeUsd, trade.feeSol, trade.totalFee, trade.totalFees, trade.fee?.sol, trade.fee?.usd];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return 0;
}

module.exports = {
  extractTimestamp,
  extractSide,
  extractAmount,
  extractPrice,
  extractFees,
};
