

// lib/parseTrades.js
// Parse raw SolanaTracker trade data into normalized rows and optionally save to JSON.

const fs = require('fs');
const path = require('path');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function toEpochSeconds(t) {
  if (t === undefined || t === null) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function inferSide(trade) {
  const fromAddr = trade?.from?.address;
  const toAddr = trade?.to?.address;
  const sideStr = (trade?.side || trade?.action || trade?.direction || '').toLowerCase();
  if (sideStr === 'buy' || sideStr === 'sell') return sideStr;
  if (fromAddr === SOL_MINT && toAddr && toAddr !== SOL_MINT) return 'buy';   // spent SOL to buy token
  if (toAddr === SOL_MINT && fromAddr && fromAddr !== SOL_MINT) return 'sell'; // received SOL by selling token
  return 'unknown';
}

function inferMint(trade, side) {
  const fromAddr = trade?.from?.address;
  const toAddr = trade?.to?.address;
  if (side === 'buy') {
    // Bought token is on the TO leg when spending SOL
    if (fromAddr === SOL_MINT && toAddr && toAddr !== SOL_MINT) return toAddr;
  } else if (side === 'sell') {
    // Sold token is on the FROM leg when receiving SOL
    if (toAddr === SOL_MINT && fromAddr && fromAddr !== SOL_MINT) return fromAddr;
  }
  return (
    trade?.mint ||
    trade?.tokenMint ||
    trade?.token?.address ||
    null
  );
}

function inferSizeSol(trade, side) {
  const volSol = trade?.volume?.sol;
  if (Number.isFinite(volSol)) return Number(volSol);
  const fromAmt = Number(trade?.from?.amount);
  const toAmt = Number(trade?.to?.amount);
  if (side === 'buy' && Number.isFinite(fromAmt) && trade?.from?.address === SOL_MINT) return fromAmt;
  if (side === 'sell' && Number.isFinite(toAmt) && trade?.to?.address === SOL_MINT) return toAmt;
  return null;
}

function inferPriceUsd(trade) {
  const p = trade?.price?.usd;
  if (Number.isFinite(Number(p))) return Number(p);
  const fromUsd = Number(trade?.from?.priceUsd);
  if (Number.isFinite(fromUsd)) return fromUsd;
  const toUsd = Number(trade?.to?.priceUsd);
  if (Number.isFinite(toUsd)) return toUsd;
  return null;
}

/**
 * Parse raw trades from SolanaTracker into compact rows.
 * @param {Array} rawTrades
 * @returns {Array} parsed
 */
function parseTrades(rawTrades = []) {
  if (!Array.isArray(rawTrades)) return [];

  const rows = rawTrades.map(trade => {
    const ts = toEpochSeconds(trade?.time || trade?.ts || trade?.timestamp || trade?.blockTime);
    const side = inferSide(trade);
    const mint = inferMint(trade, side);
    const sizeSol = inferSizeSol(trade, side);
    const priceUsd = inferPriceUsd(trade);
    const program = trade?.program || trade?.venue || trade?.source || null;

    return { ts, mint, side, sizeSol, priceUsd, program };
  });

  // Drop unusable rows (missing ts or mint) but keep count visible in log
  const filtered = rows.filter(r => r.ts && r.mint);
  if (filtered.length !== rows.length) {
    const dropped = rows.length - filtered.length;
    console.warn(`[parseTrades] dropped ${dropped} rows missing ts/mint (kept ${filtered.length})`);
  }
  return filtered;
}

/**
 * Save parsed trades to a JSON file under ./data
 * @param {string} wallet
 * @param {Array} parsed
 */
function saveAsJson(wallet, parsed) {
  const dir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const outPath = path.join(dir, `${wallet}.json`);
  fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  console.log(`[parseTrades] wrote ${parsed.length} trades to ${outPath}`);
  return outPath;
}

module.exports = {
  parseTrades,
  saveAsJson,
};