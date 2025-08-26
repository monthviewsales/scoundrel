

// lib/harvestWallet.js — orchestrator stub
// Replace this with the real SolanaTracker + feature extraction + uploader pipeline.

const Features = require('./featureExtract');
const { sendBatch } = require('./openAiUploader');

async function harvestWallet({ wallet, startTime, endTime }) {
  console.log(`[harvestWallet] starting for wallet=${wallet}, startTime=${startTime || 'N/A'}, endTime=${endTime || 'N/A'}`);

  // TODO: integrate SolanaTracker API calls here to get trades.
  // For now, fake a trade + snapshot to simulate pipeline flow.
  const fakeTrade = {
    side: 'buy',
    size: 0.1,
    mint: 'FakeMintAddress',
    priorityFee: 0.00001,
    platformFeeUI: 0.0001,
    lpFeeUI: 0.00005,
  };

  const fakeSnapshot = {
    price: { quote: 0.00000123, usd: 0.00000123 },
    liquidity: 50000,
    spread: 0.8,
    poolAgeMin: 120,
    creatorFlags: ['renounced'],
  };

  const features = Features.make(fakeTrade, fakeSnapshot);
  const net = Features.normalizeFeesAndPnL({ trade: fakeTrade, labels: { pnl5m: -0.0002 } });

  const enriched = [{
    wallet,
    mint: fakeTrade.mint,
    trade: fakeTrade,
    snapshot: fakeSnapshot,
    features,
    net,
  }];

  // Send batch to OpenAI uploader (stub)
  const res = await sendBatch(enriched);

  console.log('[harvestWallet] pipeline finished');
  return { wallet, startTime: startTime || null, endTime: endTime || null, count: enriched.length, openAiResult: res };
}

module.exports = { harvestWallet };