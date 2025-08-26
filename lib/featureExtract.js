

// lib/featureExtract.js — stub implementation
// Replace with real feature engineering logic once SolanaTracker integration is ready.

function make(trade, snapshot) {
  // Example stub: return a few key fields
  return {
    side: trade.side || 'unknown',
    size: trade.size || 0,
    price: snapshot?.price?.quote || null,
    priceUsd: snapshot?.price?.usd || null,
    liquidity: snapshot?.liquidity || null,
    spread: snapshot?.spread || null,
    poolAgeMin: snapshot?.poolAgeMin || null,
    creatorFlags: snapshot?.creatorFlags || [],
  };
}

function normalizeFeesAndPnL({ trade, labels }) {
  const fees =
    (trade.priorityFee || 0) +
    (trade.platformFeeUI || 0) +
    (trade.lpFeeUI || 0);

  return {
    fees,
    netAt5m: (labels?.pnl5m || 0) - fees,
    netAt15m: (labels?.pnl15m || 0) - fees,
    netAt1h: (labels?.pnl1h || 0) - fees,
    netAt24h: (labels?.pnl24h || 0) - fees,
  };
}

module.exports = {
  make,
  normalizeFeesAndPnL,
};