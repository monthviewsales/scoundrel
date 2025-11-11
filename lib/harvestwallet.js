// lib/harvestWallet.js — orchestrator (real flow)
// Pull wallet trades → parse → enrich with t0 snapshots → send to OpenAI

const { SolanaTrackerDataClient } = require('./solanaTrackerDataClient');
const { analyzeWallet } = require('../ai/jobs/walletAnalysis');
const { query } = require('./db/mysql');
const { requestId } = require('./id/issuer');
const { saveJobRun } = require('./persist/saveJobRun');
const ENV = process.env.NODE_ENV || 'development';
const log = {
  debug: (...a) => { if (ENV === 'development') console.debug(...a); },
  info:  (...a) => { if (ENV === 'development') console.log(...a); },
  warn:  (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};
const J = (v) => JSON.stringify(v, null, 2);
const path = require('path');
const fs = require('fs');
const SAVE_RAW = String(process.env.SAVE_RAW || '').toLowerCase() === 'true';
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const DEFAULT_LIMIT = Number(process.env.HARVEST_LIMIT || 100);
const SAVE_ENRICHED = String(process.env.SAVE_ENRICHED || '').toLowerCase() === 'true';
const FEATURE_MINT_COUNT_DEFAULT = Number(process.env.FEATURE_MINT_COUNT || 8);

// === technique feature helpers (additive) ===
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const it of arr || []) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}
function mean(a){ if(!a||!a.length) return null; return a.reduce((x,y)=>x+y,0)/a.length; }
function median(a){ if(!a||!a.length) return null; const s=[...a].sort((x,y)=>x-y); const i=Math.floor(s.length/2); return s.length%2?s[i]:(s[i-1]+s[i])/2; }
function percentile(a,p){ if(!a||!a.length) return null; const s=[...a].sort((x,y)=>x-y); const idx=Math.min(s.length-1, Math.max(0, Math.round((p/100)*(s.length-1)))); return s[idx]; }
function stddev(a){ if(!a||!a.length) return null; const m=mean(a); const v=mean(a.map(x=>Math.pow(x-m,2))); return Math.sqrt(v); }
function timeDiffs(ts){ const out=[]; for(let i=1;i<ts.length;i++){ out.push((ts[i]-ts[i-1])/60000); } return out; }
const last = a => (a && a.length ? a[a.length-1] : null);
const first = a => (a && a.length ? a[0] : null);

const { getUserTokenTradesByWallet } = require('../integrations/solanatracker/userTokenTrades');

// Known SOL mints to exclude when deriving token mints (WSOL and common aliases)
const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'sol', 'SOL', 'wSOL', 'WSOL'
]);

// Stablecoin mints to ignore when swapping out of SOL (profit-taking to stables)
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',  // USD1 (Solana variant)
]);

function isSolMint(addr){ return !!addr && (addr === 'So11111111111111111111111111111111111111112' || SOL_MINTS.has(addr)); }
function isStableMint(addr){ return !!addr && STABLE_MINTS.has(addr); }
function isSolToStableSwap(t){
  const fromAddr = get(t, 'from.address');
  const toAddr   = get(t, 'to.address');
  return isSolMint(fromAddr) && isStableMint(toAddr);
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function pickNonSolMint(a, b) {
  if (a && !SOL_MINTS.has(a)) return a;
  if (b && !SOL_MINTS.has(b)) return b;
  return a || b || null;
}

function extractMintFromTrade(t) {
  // Prefer explicit from/to.address fields (seen in SolanaTracker wallet trades)
  const fromAddr = get(t, 'from.address');
  const toAddr = get(t, 'to.address');
  if (fromAddr || toAddr) {
    const chosen = pickNonSolMint(fromAddr, toAddr);
    if (chosen && typeof chosen === 'string' && chosen.length > 20) return chosen;
  }

  // Common direct fields
  const candidates = [
    t.mint,
    t.mintAddress,
    t.tokenMint,
    t.token_mint_address,
    t.tokenAddress,
    t.baseTokenAddress,
    t.address,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.length > 20) return c;

  // Nested token/base/quote shapes
  const nested = [
    get(t, 'token.mint'),
    get(t, 'token.address'),
    get(t, 'base.mint'),
    get(t, 'quote.mint'),
    get(t, 'pool.mint'),
  ];
  for (const c of nested) if (typeof c === 'string' && c.length > 20) return c;

  // If base/quote mints exist, choose the non-SOL one
  const baseMint = get(t, 'base.mint') || get(t, 'baseTokenAddress') || get(t, 'baseMint');
  const quoteMint = get(t, 'quote.mint') || get(t, 'quoteTokenAddress') || get(t, 'quoteMint');
  const chosen = pickNonSolMint(baseMint, quoteMint);
  if (chosen && typeof chosen === 'string' && chosen.length > 20) return chosen;

  return null;
}

function computeRealizedStats(buys, sells){
  let openQty = 0; let firstBuyTs = null; const gains = []; const holds = []; const buyQueue = [];
  for (const b of buys){
    buyQueue.push({ qty:b.amount, priceUsd:b.priceUsd, time:b.time });
    openQty += b.amount;
    if (firstBuyTs == null) firstBuyTs = b.time;
  }
  for (const s of sells){
    let sellQty = s.amount; let realizedUsd = 0; let spentUsd = 0;
    while (sellQty>0 && buyQueue.length){
      const lot = buyQueue[0];
      const take = Math.min(lot.qty, sellQty);
      realizedUsd += take * s.priceUsd;
      spentUsd   += take * lot.priceUsd;
      lot.qty    -= take;
      sellQty    -= take;
      if (lot.qty<=0) buyQueue.shift();
    }
    if (spentUsd>0){ gains.push((realizedUsd - spentUsd)/spentUsd * 100); }
    if (!buyQueue.length && firstBuyTs!=null){ holds.push((s.time - firstBuyTs)/60000); firstBuyTs=null; }
  }
  return {
    nClosed: gains.length,
    medianGainPct: median(gains),
    p75GainPct: percentile(gains,75),
    medianHoldMins: median(holds),
  };
}

function detectEntryStyle(buys){
  if (buys.length <= 1) return { signal: 'single', confidence: 0.9 };
  const times = buys.map(b=>b.time).sort((a,b)=>a-b);
  const diffs = timeDiffs(times);
  const avg = mean(diffs) || 0; const sd = stddev(diffs) || 0;
  const clustered = diffs.some(d => d <= 15); // minutes
  if (buys.length >= 3 && avg>0 && sd/avg <= 0.10) return { signal: 'twap', confidence: 0.75 };
  if (clustered) return { signal: 'scale_in', confidence: 0.70 };
  return { signal: 'dca', confidence: 0.50 };
}

async function harvestWallet({ wallet, traderName, startTime, endTime, limit = DEFAULT_LIMIT, concurrency = 6, includeOutcomes = false, featureMintCount = FEATURE_MINT_COUNT_DEFAULT }) {
  log.info(`[harvestWallet] start wallet=${wallet} trader=${traderName || 'N/A'} start=${startTime || 'N/A'} end=${endTime || 'N/A'} limit=${limit} concurrency=${concurrency}`);

  if (!wallet) throw new Error('[harvestWallet] wallet is required');

  if (!process.env.SOLANATRACKER_API_KEY) throw new Error('Missing SOLANATRACKER_API_KEY in environment');
  const st = new SolanaTrackerDataClient({ apiKey: process.env.SOLANATRACKER_API_KEY });

  try {
    // 1) Fetch raw trades from SolanaTracker
    const rawTrades = await st.getWalletTrades({ wallet, startTime, endTime, limit });
    log.info(`[harvestWallet] fetched ${rawTrades.length} raw trades`);

    if (!rawTrades.length) {
      return { wallet, startTime: startTime || null, endTime: endTime || null, count: 0, openAiResult: [], enriched: null };
    }

    // Define data directory early for all file outputs
    const dataDir = path.join(process.cwd(), 'data');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}

    // 1b) Fetch wallet chart
    let rawChart = [];
    try {
      const chartResp = await st.getWalletChart(wallet);
      // Use the API response as-is without selecting inner fields
      rawChart = chartResp;
    } catch (e) {
      log.warn('[harvestWallet] wallet chart fetch failed:', e?.message || e);
    }

    // Write chart samples similar to trades for easier debugging/verification
    const chartSample = Array.isArray(rawChart) ? rawChart.slice(0, 5) : [];
    const chartSamplePath = path.join(dataDir, `${wallet}-chart-sample-${runId}.json`);
    try { fs.writeFileSync(chartSamplePath, J(chartSample)); log.info(`[harvestWallet] wrote chart sample (${chartSample.length}) → ${chartSamplePath}`); } catch (_) {}
    if (SAVE_RAW) {
      const chartFullPath = path.join(dataDir, `${wallet}-chart-${runId}.json`);
      try { fs.writeFileSync(chartFullPath, J(rawChart)); log.info(`[harvestWallet] wrote full chart (${Array.isArray(rawChart) ? rawChart.length : 0}) → ${chartFullPath}`); } catch (_) {}
    }

    // 1.5) Persist raw samples (always small sample; optional full)
    // const dataDir = path.join(process.cwd(), 'data');
    // try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
    const sample = rawTrades.slice(0, 5);
    const samplePath = path.join(dataDir, `${wallet}-raw-sample-${runId}.json`);
    try { fs.writeFileSync(samplePath, J(sample)); log.info(`[harvestWallet] wrote raw sample (${sample.length}) → ${samplePath}`); } catch (_) {}
    if (SAVE_RAW) {
      const fullPath = path.join(dataDir, `${wallet}-raw-${runId}.json`);
      try { fs.writeFileSync(fullPath, J(rawTrades)); log.info(`[harvestWallet] wrote full raw (${rawTrades.length}) → ${fullPath}`); } catch (_) {}
    }


    // 1.6) Derive last N distinct token mints (skip SOL), most-recent first
    const lastMints = [];
    const seenMints = new Set();
    for (const t of rawTrades) {
      // Skip SOL → stable profit-taking swaps from analysis
      if (isSolToStableSwap(t)) continue;
      const mint = extractMintFromTrade(t);
      if (!mint) continue;
      if (!seenMints.has(mint)) {
        seenMints.add(mint);
        // Also skip stable mints defensively (in case extractMint chose the stable leg)
        if (isStableMint(mint)) continue;
        lastMints.push(mint);
        if (lastMints.length >= featureMintCount) break;
      }
    }

    if (ENV === 'development') {
      if (lastMints.length === 0) {
        const first = rawTrades[0];
        const keys = first ? Object.keys(first) : [];
        log.warn('[harvestWallet] mint derivation found 0 mints. Sample trade keys:', keys.join(','));
      } else {
        log.info(`[harvestWallet] last ${lastMints.length}/${featureMintCount} mints:`, lastMints.join(', '));
      }
    }

    // 1.7) Fetch user-specific token trades for each mint (first page only, raw kept in dev)
    const mintTradesByMint = {};
    for (const mint of lastMints) {
      try {
        const resp = await getUserTokenTradesByWallet({
          tokenAddress: mint,
          owner: wallet,
          apiKey: process.env.SOLANATRACKER_API_KEY,
          parseJupiter: true,
          hideArb: true,
          showMeta: false,
          sortDirection: 'DESC',
        });

        const mintTrades = Array.isArray(resp?.trades)
          ? resp.trades
          : Array.isArray(resp?.data)
            ? resp.data
            : Array.isArray(resp)
              ? resp
              : [];
        const count = Array.isArray(mintTrades) ? mintTrades.length : 0;
        if (ENV === 'development') log.info(`[harvestWallet] mint ${mint} user-trades fetched: ${count}`);

        // Save a tiny sample (array slice if applicable)
        const mintSample = Array.isArray(mintTrades) ? mintTrades.slice(0, 5) : [];
        const mintSamplePath = path.join(dataDir, `${wallet}-${mint}-minttrades-sample-${runId}.json`);
        try { fs.writeFileSync(mintSamplePath, J(mintSample)); } catch (_) {}

        // Save full raw in dev if enabled
        if (SAVE_RAW) {
          const mintFullPath = path.join(dataDir, `${wallet}-${mint}-minttrades-${runId}.json`);
          try { fs.writeFileSync(mintFullPath, J(resp)); } catch (_) {}
        }

        // Add a trimmed slice to the merged payload (cap to 50 rows)
        mintTradesByMint[mint] = Array.isArray(mintTrades) ? mintTrades.slice(0, 50) : mintTrades;
      } catch (e) {
        log.warn(`[harvestWallet] mint trades fetch failed for ${mint}:`, e?.message || e);
      }
    }

    // Build technique features for last N mints using per-mint trade lists
    function buildTechniqueFeaturesFromMintMap(mintMap){
      const rows = [];
      for (const [mint, list] of Object.entries(mintMap)){
        if (isStableMint(mint)) continue;
        const buys  = (list||[]).filter(t=>t.type==='buy').sort((a,b)=>a.time-b.time);
        const sells = (list||[]).filter(t=>t.type==='sell').sort((a,b)=>a.time-b.time);
        if (!buys.length && !sells.length) continue;
        const lastTs = Math.max(...(list||[]).map(t=>t.time||0));
        const spacing = timeDiffs(buys.map(b=>b.time));
        const style = detectEntryStyle(buys);
        const realized = computeRealizedStats(buys, sells);
        const venueCounts = buys.reduce((acc,t)=>{ const k=t.program||'unknown'; acc[k]=(acc[k]||0)+1; return acc; },{});
        const total = Object.values(venueCounts).reduce((a,b)=>a+b,0) || 1;
        const venueMix = Object.fromEntries(Object.entries(venueCounts).map(([k,v])=>[k, v/total]));
        rows.push({
          mint,
          symbol: buys[0]?.meta?.to?.symbol || sells[0]?.meta?.to?.symbol || null,
          startTs: first(buys)?.time ?? first(list)?.time ?? null,
          endTs:   last(sells)?.time  ?? lastTs,
          nBuys: buys.length,
          nSells: sells.length,
          entrySpacingMinsAvg: mean(spacing),
          entrySpacingMinsStd: stddev(spacing),
          entryStyleSignal: style.signal,
          entryStyleConfidence: style.confidence,
          realized,
          venueMix,
          marketCapEntryUsdMedian: null,
        });
      }
      // last N by latest activity
      const picked = rows.sort((a,b)=>(b.endTs||0)-(a.endTs||0)).slice(0, featureMintCount);
      const realizedRows = picked.map(r=>r.realized).filter(Boolean);
      const overall = {
        nCoins: picked.length,
        meanBuysPerCoin: mean(picked.map(r=>r.nBuys)) || 0,
        medianHoldMins: median(realizedRows.map(r=>r.medianHoldMins).filter(v=>v!=null)),
        winRate: (()=>{ const med = realizedRows.map(r=>r.medianGainPct).filter(v=>v!=null); if(!med.length) return 0; const wins=med.filter(x=>x>0).length; return wins/med.length; })(),
        avgRealizedGainPct: mean(realizedRows.map(r=>r.medianGainPct).filter(v=>v!=null)) || null,
        venueShare: (()=>{ const acc={}; for(const m of picked){ for(const [k,v] of Object.entries(m.venueMix)) acc[k]=(acc[k]||0)+v; } const tot=Object.values(acc).reduce((a,b)=>a+b,0)||1; for(const k in acc) acc[k]=acc[k]/tot; return acc; })(),
        marketCapEntryUsdMedian: null,
      };
      return { coins: picked, overall };
    }

    // 2) Build merged payload for Responses job
    const meta = { wallet, traderName: traderName || null, startTime: startTime || null, endTime: endTime || null, fetchedAt: new Date().toISOString(), featureMintCount };
    const techniqueFeatures = buildTechniqueFeaturesFromMintMap(mintTradesByMint);
    const merged = { meta, trades: rawTrades, chart: rawChart, userTokenTradesByMint: mintTradesByMint, techniqueFeatures };

    // Write the final merged payload for inspection (dev or when SAVE_ENRICHED=true)
    if (ENV === 'development' || SAVE_ENRICHED) {
      const mergedPath = path.join(dataDir, `${wallet}-merged-${runId}.json`);
      try {
        fs.writeFileSync(mergedPath, J(merged));
        log.info(`[harvestWallet] wrote merged payload → ${mergedPath}`);
      } catch (e) {
        log.warn('[harvestWallet] failed to write merged payload:', e?.message || e);
      }
      const featuresPath = path.join(dataDir, `${wallet}-features-${runId}.json`);
      try { fs.writeFileSync(featuresPath, J(techniqueFeatures)); log.info(`[harvestWallet] wrote features → ${featuresPath}`); } catch (_) {}
    }

    log.debug('[harvestWallet] merged sizes before analyze:', { trades: Array.isArray(rawTrades) ? rawTrades.length : -1, chart: Array.isArray(rawChart) ? rawChart.length : -1 });
    log.info(`[harvestWallet] feature mints requested: ${featureMintCount}`);

    // 3) Call Responses job (schema-locked)
    const openAiResult = await analyzeWallet({
      merged,
      model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini',
      purpose: 'Analyze this wallet\'s trades and chart and return the schema-locked JSON.'
    });

    // 3.4) Persist generic job run (sc_job_runs)
    try {
      await saveJobRun({
        job: 'walletAnalysis',
        context: { wallet, label: traderName || null },
        input: { merged },
        responseRaw: openAiResult,
      });
      if (ENV === 'development') log.info('[harvestWallet] saved job run (sc_job_runs)');
    } catch (e) {
      log.warn('[harvestWallet] failed to save job run:', e?.message || e);
    }

    // 3.5) Persist merged input + model response, then save profile and cleanup artifacts
    try {
      const analysisIdRaw = await requestId({ prefix: 'analysis' });
      const analysisId = String(analysisIdRaw).slice(-26);

      // Insert a durable record for this analysis run
      await query(
        `INSERT INTO sc_wallet_analyses (
          analysis_id, wallet, trader_name, trade_count, chart_count, merged, response_raw
        ) VALUES (
          :analysis_id, :wallet, :trader_name, :trade_count, :chart_count, CAST(:merged AS JSON), CAST(:response_raw AS JSON)
        )`,
        {
          analysis_id: analysisId,
          wallet,
          trader_name: traderName || null,
          trade_count: Array.isArray(rawTrades) ? rawTrades.length : 0,
          chart_count: Array.isArray(rawChart) ? rawChart.length : 0,
          merged: JSON.stringify(merged),
          response_raw: JSON.stringify(openAiResult),
        }
      );

      if (ENV === 'development') log.info(`[harvestWallet] persisted analysis ${analysisId}`);

      // Save human-readable profile JSON (final AI output)
      try {
        const profilesDir = path.join(process.cwd(), 'profiles');
        try { fs.mkdirSync(profilesDir, { recursive: true }); } catch (_) {}
        const safeName = (traderName || wallet).replace(/[^a-z0-9_-]/gi, '_');
        const profilePath = path.join(profilesDir, `${safeName}.json`);
        fs.writeFileSync(profilePath, J(openAiResult));
        if (ENV === 'development') log.info(`[harvestWallet] wrote profile → ${profilePath}`);
      } catch (e) {
        log.warn('[harvestWallet] failed to write profile JSON:', e?.message || e);
      }

      // Cleanup SolanaTracker artifacts:
      //  - In development: keep samples/full artifacts for inspection
      //  - In production : delete artifacts and keep only the profile JSON
      if (ENV === 'development') {
        if (ENV === 'development') log.info('[harvestWallet] dev mode: keeping SolanaTracker artifacts on disk');
      } else {
        try {
          // Remove sample files created earlier
          try { fs.unlinkSync(path.join(process.cwd(), 'data', `${wallet}-raw-sample-${runId}.json`)); } catch (_) {}
          try { fs.unlinkSync(path.join(process.cwd(), 'data', `${wallet}-chart-sample-${runId}.json`)); } catch (_) {}

          // Remove full files if they were written under SAVE_RAW
          if (SAVE_RAW) {
            try { fs.unlinkSync(path.join(process.cwd(), 'data', `${wallet}-raw-${runId}.json`)); } catch (_) {}
            try { fs.unlinkSync(path.join(process.cwd(), 'data', `${wallet}-chart-${runId}.json`)); } catch (_) {}
          }
        } catch (cleanupErr) {
          log.warn('[harvestWallet] cleanup warning:', cleanupErr?.message || cleanupErr);
        }
      }
    } catch (persistErr) {
      // Non-fatal: analysis still returns to caller
      log.warn('[harvestWallet] failed to persist analysis:', persistErr?.message || persistErr);
    }

    log.info('[harvestWallet] analysis complete');
    return { wallet, traderName: meta.traderName, startTime: meta.startTime, endTime: meta.endTime, count: rawTrades.length, errors: 0, enriched: null, openAiResult };
  } catch (err) {
    console.error('[harvestWallet] error:', err?.message || err);
    throw err;
  }
}

module.exports = { harvestWallet };
