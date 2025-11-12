/**
 * @fileoverview Orchestrates a single-pass wallet dossier build:
 *  1) Fetch wallet trades and chart from SolanaTracker
 *  2) Derive last N distinct token mints and fetch per-mint user trades
 *  3) Build technique features and merge everything into a single payload
 *  4) (Default) Send one OpenAI Responses job and persist results
 *
 * Design goals:
 *  - Keep it simple and deterministic (no agent chains)
 *  - Always write the merged pre-OpenAI payload for traceability
 *  - Avoid tiny sample files; only write full artifacts when SAVE_RAW=true
 *
 * Env:
 *  - SOLANATRACKER_API_KEY (required)
 *  - OPENAI_RESPONSES_MODEL (optional; has a default)
 *  - HARVEST_LIMIT / FEATURE_MINT_COUNT (optional defaults)
 *  - SAVE_RAW=false by default
 */
/**
 * @typedef {Object} Trade
 * @property {string} [mint]
 * @property {string} [mintAddress]
 * @property {string} [tokenMint]
 * @property {{ address?: string }} [from]
 * @property {{ address?: string }} [to]
 * @property {{ mint?: string, address?: string }} [token]
 * @property {{ mint?: string }} [base]
 * @property {{ mint?: string }} [quote]
 * @property {{ mint?: string }} [pool]
 */
/**
 * @typedef {Object} ChartPoint
 * @property {number|string} [t]  Timestamp (epoch/ISO)
 * @property {number} [v]         Balance/value
 */
/** @typedef {Object.<string, Trade[]>} UserTokenTradesByMint */
/**
 * @typedef {Object} TechniqueFeatures
 * @description Summary features describing trading technique across mints.
 */
/**
 * @typedef {Object} MergedPayload
 * @property {{ wallet: string, traderName: (string|null), startTime: (number|null), endTime: (number|null), fetchedAt: string, featureMintCount: number }} meta
 * @property {Trade[]} trades
 * @property {ChartPoint[]|any[]} chart
 * @property {UserTokenTradesByMint} userTokenTradesByMint
 * @property {TechniqueFeatures} techniqueFeatures
 */
/**
 * @typedef {Object} HarvestOptions
 * @property {string} wallet
 * @property {string} [traderName]
 * @property {number} [startTime]
 * @property {number} [endTime]
 * @property {number} [limit]
 * @property {number} [concurrency]
 * @property {boolean} [includeOutcomes]
 * @property {number} [featureMintCount]
 * @property {boolean} [runAnalysis]
 */
/**
 * @typedef {Object} HarvestResult
 * @property {string} wallet
 * @property {string|null} traderName
 * @property {number|null} startTime
 * @property {number|null} endTime
 * @property {number} count
 * @property {number} [errors]
 * @property {any} [openAiResult]
 * @property {MergedPayload} [merged]
 * @property {TechniqueFeatures} [techniqueFeatures]
 */
// lib/dossier.js — single-pass dossier orchestrator
// Pull wallet trades → derive mints → per-mint user trades → technique features → single OpenAI Responses call

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
const SAVE_RAW = String(process.env.SAVE_RAW || '').toLowerCase() === 'true'; // default false
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const DEFAULT_LIMIT = Number(process.env.HARVEST_LIMIT || 100);
const SAVE_ENRICHED = String(process.env.SAVE_ENRICHED || '').toLowerCase() === 'true';
const FEATURE_MINT_COUNT_DEFAULT = Number(process.env.FEATURE_MINT_COUNT || 8);
const { buildTechniqueFeaturesFromMintMap } = require('./analysis/techniqueOutcomes');


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

/** Return true if the given string looks like a base58 Solana mint address. */
function isBase58Mint(v){
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/** @param {string} addr */
function isSolMint(addr){ return !!addr && (addr === 'So11111111111111111111111111111111111111112' || SOL_MINTS.has(addr)); }
/** @param {string} addr */
function isStableMint(addr){ return !!addr && STABLE_MINTS.has(addr); }
/** Heuristic: treat SOL→stable swaps as profit-taking and skip in mint derivation. */
function isSolToStableSwap(t){
  const fromAddr = get(t, 'from.address');
  const toAddr   = get(t, 'to.address');
  return isSolMint(fromAddr) && isStableMint(toAddr);
}

/** Tiny dot-path getter to avoid a lodash dep. */
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/** Prefer a non-SOL candidate mint. */
function pickNonSolMint(a, b) {
  if (a && !SOL_MINTS.has(a)) return a;
  if (b && !SOL_MINTS.has(b)) return b;
  return a || b || null;
}

/**
 * Attempt to extract the traded token mint from a variety of SolanaTracker trade shapes.
 * @param {Trade} t
 * @returns {string|null}
 */
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

  // Guard against accidental literal strings like "mint"
  if (t && typeof t.mint === 'string' && t.mint.toLowerCase() === 'mint') return null;

  return null;
}


/**
 * Build a wallet dossier in one pass:
 *  - Fetch wallet-level trades and chart
 *  - Derive last N distinct token mints (skip SOL and stables)
 *  - Fetch user-specific trades for those mints (first page)
 *  - Build technique features and merge into a single payload
 *  - Optionally call OpenAI Responses to produce the final profile
 *
 * @param {HarvestOptions} options
 * @returns {Promise<HarvestResult>}
 */
async function harvestWallet({ wallet, traderName, startTime, endTime, limit = DEFAULT_LIMIT, concurrency = 6, includeOutcomes = false, featureMintCount = FEATURE_MINT_COUNT_DEFAULT, runAnalysis = true }) {
  log.info(`[dossier] start wallet=${wallet} trader=${traderName || 'N/A'} start=${startTime || 'N/A'} end=${endTime || 'N/A'} limit=${limit} concurrency=${concurrency}`);
  const label = (traderName || wallet);
  const safeName = String(label).replace(/[^a-z0-9_-]/gi, '_');

  if (!wallet) throw new Error('[dossier] wallet is required');

  if (!process.env.SOLANATRACKER_API_KEY) throw new Error('Missing SOLANATRACKER_API_KEY in environment');
  const st = new SolanaTrackerDataClient({ apiKey: process.env.SOLANATRACKER_API_KEY });

  try {
    // 1) Fetch raw trades from SolanaTracker
    const rawTrades = await st.getWalletTrades({ wallet, startTime, endTime, limit });
    log.info(`[dossier] fetched ${rawTrades.length} raw trades`);

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
      log.warn('[dossier] wallet chart fetch failed:', e?.message || e);
    }

    // Optionally write full chart when SAVE_RAW=true
    if (SAVE_RAW) {
      const chartFullPath = path.join(dataDir, `${safeName}-chart-${runId}.json`);
      try { fs.writeFileSync(chartFullPath, J(rawChart)); log.info(`[dossier] wrote full chart (${Array.isArray(rawChart) ? rawChart.length : 0}) → ${chartFullPath}`); } catch (_) {}
    }

    // Optionally write full raw trades when SAVE_RAW=true
    if (SAVE_RAW) {
      const fullPath = path.join(dataDir, `${safeName}-raw-${runId}.json`);
      try { fs.writeFileSync(fullPath, J(rawTrades)); log.info(`[dossier] wrote full raw (${rawTrades.length}) → ${fullPath}`); } catch (_) {}
    }


    // 1.6) Derive last N distinct token mints (skip SOL), most-recent first
    // Derive last N distinct token mints, skipping SOL and stables (default N=8)
    const lastMints = [];
    const seenMints = new Set();
    for (const t of rawTrades) {
      // Skip SOL → stable profit-taking swaps from analysis
      if (isSolToStableSwap(t)) continue;
      const mint = extractMintFromTrade(t);
      if (!mint) continue;
      if (mint.toLowerCase && mint.toLowerCase() === 'mint') continue; // bad literal
      if (!isBase58Mint(mint)) { if (ENV === 'development') log.warn('[dossier] skipping non-base58 mint:', mint); continue; }
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
        log.warn('[dossier] mint derivation found 0 mints. Sample trade keys:', keys.join(','));
      } else {
        log.info(`[dossier] last ${lastMints.length}/${featureMintCount} mints:`, lastMints.join(', '));
      }
    }

    // 1.7) Fetch user-specific token trades for each mint (first page only, raw kept in dev)
    const mintTradesByMint = {};
    for (const mint of lastMints) {
      try {
        const reqParams = {
          mint,
          tokenAddress: mint,
          owner: wallet,
          apiKey: process.env.SOLANATRACKER_API_KEY,
          parseJupiter: true,
          hideArb: true,
          showMeta: false,
          sortDirection: 'DESC',
        };
        if (ENV === 'development') log.info('[dossier] fetching user-token-trades', { mint, owner: wallet, sortDirection: reqParams.sortDirection });

        const resp = await getUserTokenTradesByWallet(reqParams);

        const mintTrades = Array.isArray(resp?.trades)
          ? resp.trades
          : Array.isArray(resp?.data)
            ? resp.data
            : Array.isArray(resp)
              ? resp
              : [];
        const count = Array.isArray(mintTrades) ? mintTrades.length : 0;
        if (ENV === 'development') log.info(`[dossier] mint ${mint} user-trades fetched: ${count}`);

        // Save full raw in dev if enabled
        if (SAVE_RAW) {
          const mintFullPath = path.join(dataDir, `${safeName}-${mint}-minttrades-${runId}.json`);
          try { fs.writeFileSync(mintFullPath, J(resp)); } catch (_) {}
        }

        // Add a trimmed slice to the merged payload (cap to 50 rows)
        mintTradesByMint[mint] = Array.isArray(mintTrades) ? mintTrades.slice(0, 50) : mintTrades;
      } catch (e) {
        const status = e?.status || e?.response?.status;
        const data = e?.response?.data || e?.data || e?.body;
        log.warn(`[dossier] mint trades fetch failed for ${mint}:`, status ? `status ${status}` : '', data ? J(data) : (e?.message || e));
      }
    }

    // 2) Build merged payload for Responses job
    const meta = { wallet, traderName: traderName || null, startTime: startTime || null, endTime: endTime || null, fetchedAt: new Date().toISOString(), featureMintCount };
    const techniqueFeatures = buildTechniqueFeaturesFromMintMap(mintTradesByMint, featureMintCount);
    const merged = { meta, trades: rawTrades, chart: rawChart, userTokenTradesByMint: mintTradesByMint, techniqueFeatures };

    // Always write the final merged pre-OpenAI payload
    const mergedPath = path.join(dataDir, `${safeName}-merged-${runId}.json`);
    try {
      fs.writeFileSync(mergedPath, J(merged));
      log.info(`[dossier] wrote merged payload → ${mergedPath}`);
    } catch (e) {
      log.warn('[dossier] failed to write merged payload:', e?.message || e);
    }

    log.debug('[dossier] merged sizes before analyze:', { trades: Array.isArray(rawTrades) ? rawTrades.length : -1, chart: Array.isArray(rawChart) ? rawChart.length : -1 });
    log.info(`[dossier] feature mints requested: ${featureMintCount}`);

    // --- Harvest-only mode: return merged payload to orchestrator ---
    if (!runAnalysis) {
      log.info('[dossier] runAnalysis=false (harvest-only mode)');
      return {
        wallet,
        traderName: meta.traderName,
        startTime: meta.startTime,
        endTime: meta.endTime,
        count: Array.isArray(rawTrades) ? rawTrades.length : 0,
        errors: 0,
        merged,
        techniqueFeatures,
      };
    }

    // Single OpenAI Responses call with the merged payload
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
      if (ENV === 'development') log.info('[dossier] saved job run (sc_job_runs)');
    } catch (e) {
      log.warn('[dossier] failed to save job run:', e?.message || e);
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

      if (ENV === 'development') log.info(`[dossier] persisted analysis ${analysisId}`);

      // Save human-readable profile JSON (final AI output)
      try {
        const profilesDir = path.join(process.cwd(), 'profiles');
        try { fs.mkdirSync(profilesDir, { recursive: true }); } catch (_) {}
        const profilePath = path.join(profilesDir, `${safeName}.json`);
        fs.writeFileSync(profilePath, J(openAiResult));
        if (ENV === 'development') log.info(`[dossier] wrote profile → ${profilePath}`);
      } catch (e) {
        log.warn('[dossier] failed to write profile JSON:', e?.message || e);
      }

      // Cleanup SolanaTracker artifacts:
      //  - In development: keep samples/full artifacts for inspection
      //  - In production : delete artifacts and keep only the profile JSON
      if (ENV === 'development') {
        if (ENV === 'development') log.info('[dossier] dev mode: keeping SolanaTracker artifacts on disk');
      } else {
        try {
          // Remove full files if they were written under SAVE_RAW
          if (SAVE_RAW) {
            try { fs.unlinkSync(path.join(process.cwd(), 'data', `${safeName}-raw-${runId}.json`)); } catch (_) {}
            try { fs.unlinkSync(path.join(process.cwd(), 'data', `${safeName}-chart-${runId}.json`)); } catch (_) {}
          }
        } catch (cleanupErr) {
          log.warn('[dossier] cleanup warning:', cleanupErr?.message || cleanupErr);
        }
      }
    } catch (persistErr) {
      // Non-fatal: analysis still returns to caller
      log.warn('[dossier] failed to persist analysis:', persistErr?.message || persistErr);
    }

    log.info('[dossier] analysis complete');
    return {
      wallet,
      traderName: meta.traderName,
      startTime: meta.startTime,
      endTime: meta.endTime,
      count: Array.isArray(rawTrades) ? rawTrades.length : 0,
      errors: 0,
      enriched: null,
      openAiResult,
      merged,
      techniqueFeatures,
    };
  } catch (err) {
    console.error('[dossier] error:', err?.message || err);
    throw err;
  }
}

module.exports = { harvestWallet };
