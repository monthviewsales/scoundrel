

// lib/parseTrades.js
// Parse raw SolanaTracker trade data into normalized rows and optionally save to JSON.

const fs = require('fs');
const path = require('path');

/**
 * Parse raw trades from SolanaTracker into compact rows.
 * @param {Array} rawTrades
 * @returns {Array} parsed
 */
function parseTrades(rawTrades = []) {
  if (!Array.isArray(rawTrades)) return [];

  return rawTrades.map(trade => {
    const ts = trade?.time ? Math.floor(Number(trade.time) / 1000) : null;

    // infer side: if from.token is SOL → selling SOL = BUY token, else SELL
    let side = 'unknown';
    const fromMint = trade?.from?.token?.address;
    const toMint = trade?.to?.token?.address;
    if (fromMint === 'So11111111111111111111111111111111111111112') {
      side = 'buy';
    } else if (toMint === 'So11111111111111111111111111111111111111112') {
      side = 'sell';
    }

    return {
      ts,
      mint: trade?.token?.address || null,
      side,
      sizeSol: trade?.volume?.sol || null,
      priceUsd: trade?.price?.usd || null,
      program: trade?.program || null,
    };
  });
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