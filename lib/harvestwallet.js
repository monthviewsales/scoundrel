// lib/harvestWallet.js — orchestrator (real flow)
// Pull wallet trades → parse → enrich with t0 snapshots → send to OpenAI

const { SolanaTrackerClient } = require('./solanaTrackerClient');
const { parseTrades, saveAsJson } = require('./parseTrades');
const { enrichTrades } = require('./enrichTrades');
const { sendBatch } = require('./openAiUploader');
const path = require('path');
const fs = require('fs');
const SAVE_RAW = String(process.env.SAVE_RAW || '').toLowerCase() === 'true';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const { getRecentMints, groupRowsByMint } = require('./coinSets');

const DEFAULT_LIMIT = Number(process.env.HARVEST_LIMIT || 100);
const SAVE_PARSED = String(process.env.SAVE_PARSED || '').toLowerCase() === 'true';
const SAVE_ENRICHED = String(process.env.SAVE_ENRICHED || '').toLowerCase() === 'true';

async function harvestWallet({ wallet, traderName, startTime, endTime, limit = DEFAULT_LIMIT, concurrency = 6, includeOutcomes = false }) {
  console.log(`[harvestWallet] start wallet=${wallet} trader=${traderName || 'N/A'} start=${startTime || 'N/A'} end=${endTime || 'N/A'} limit=${limit} concurrency=${concurrency}`);

  if (!wallet) throw new Error('[harvestWallet] wallet is required');

  const st = new SolanaTrackerClient();

  try {
    // 1) Fetch raw trades from SolanaTracker
    const rawTrades = await st.getWalletTrades({ wallet, startTime, endTime, limit });
    console.log(`[harvestWallet] fetched ${rawTrades.length} raw trades`);

    if (!rawTrades.length) {
      return { wallet, startTime: startTime || null, endTime: endTime || null, count: 0, openAiResult: [] };
    }

    // 1.5) Persist raw data for debugging/audit
    const dataDir = path.join(process.cwd(), 'data');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}

    if (Array.isArray(rawTrades) && rawTrades.length) {
      // Always write a small sample (first 5) with a unique runId to avoid overwriting
      const sample = rawTrades.slice(0, 5);
      const samplePath = path.join(dataDir, `${wallet}-raw-sample-${runId}.json`);
      fs.writeFileSync(samplePath, JSON.stringify(sample, null, 2));
      console.log(`[harvestWallet] wrote raw sample (${sample.length}) → ${samplePath}`);

      // Optionally write the FULL raw payload if SAVE_RAW=true
      if (SAVE_RAW) {
        const fullPath = path.join(dataDir, `${wallet}-raw-${runId}.json`);
        fs.writeFileSync(fullPath, JSON.stringify(rawTrades, null, 2));
        console.log(`[harvestWallet] wrote full raw (${rawTrades.length}) → ${fullPath}`);
      }
    }

    // 2) Parse to compact rows

    const parsed = parseTrades(rawTrades);
    const parsedWithName = parsed.map(r => ({ ...r, traderName: traderName || null, wallet }));

    const recentMints = getRecentMints(parsedWithName, { count: 10 });
    const coinSets = groupRowsByMint(parsedWithName, recentMints);
    // coinSets is a Map<mint, row[]>, each row timeline for that coin
    
    // 3) Enrich with t0 snapshots + features
    // Flatten coinSets into a single array of trades (per-coin groups)
    const rowsToEnrich = Array.from(coinSets.values()).flat();
    const { enriched, count, errors } = await enrichTrades({ trades: rowsToEnrich, client: st, concurrency, includeOutcomes });
    console.log(`[harvestWallet] enriched=${count} errors=${errors}`);

    if (SAVE_ENRICHED) {
      try { saveAsJson(`${wallet}-enriched`, enriched); } catch (e) { console.warn('[harvestWallet] warn: failed to save enriched JSON:', e?.message || e); }
    }

    // 4) Send enriched batch to OpenAI (stub)
    const openAiResult = await sendBatch(enriched);

    console.log('[harvestWallet] done');
    return { wallet, traderName: traderName || null, startTime: startTime || null, endTime: endTime || null, count, errors, enriched, openAiResult };
  } catch (err) {
    console.error('[harvestWallet] error:', err?.message || err);
    throw err;
  }
}

module.exports = { harvestWallet };
