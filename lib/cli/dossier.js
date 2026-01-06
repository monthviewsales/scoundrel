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

const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const { analyzeWallet } = require('../../ai/jobs/walletDossier');
const BootyBox = require('../../db');
const { requestId } = require('../id/issuer');
const { createCommandRun } = require('./aiRun');
const { persistProfileSnapshot, persistWalletAnalysis } = require('../persist/aiPersistence');
const { normalizeTraderAlias } = require('../persist/jsonArtifacts');
const logger = require('../logger');
const J = (v) => JSON.stringify(v, null, 2);

const DEFAULT_LIMIT = Number(process.env.HARVEST_LIMIT || 100);
const FEATURE_MINT_COUNT_DEFAULT = Number(process.env.FEATURE_MINT_COUNT || 8);
const { buildFromMintMap: buildTechniqueFeaturesFromMintMap } = require('../analysis/techniqueOutcomes');
const {
  isBase58Mint,
  isStableMint,
  isSolToStableSwap,
  pickNonSolMint,
} = require('../analysis/tradeMints');
const {
  buildWalletStatsFromChart,
  buildRegimeEventsFromChart,
} = require('../analysis/walletChart');

/** Tiny dot-path getter to avoid a lodash dep. */
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
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
  logger.info(`[dossier] start wallet=${wallet} trader=${traderName || 'N/A'} start=${startTime || 'N/A'} end=${endTime || 'N/A'} limit=${limit} concurrency=${concurrency}`);
  const label = (traderName || wallet);
  const traderAlias = normalizeTraderAlias(traderName, wallet);

  const { runId, artifacts } = createCommandRun({
    command: 'dossier',
    segments: [traderAlias],
    logger,
  });

  if (!wallet) throw new Error('[dossier] wallet is required');

  let st;
  try {
    // Data client uses env vars internally (SOLANATRACKER_API_KEY, SOLANATRACKER_DATA_BASE_URL)
    st = createSolanaTrackerDataClient();

    // 1) Fetch raw trades from SolanaTracker
    const rawTrades = await st.getWalletTrades({ wallet, startTime, endTime, limit });
    logger.info(`[dossier] fetched ${rawTrades.length} raw trades`);

    if (!rawTrades.length) {
      return { wallet, startTime: startTime || null, endTime: endTime || null, count: 0, openAiResult: [], enriched: null };
    }


    // 1b) Fetch wallet chart
    let rawChart = [];
    try {
      const chartResp = await st.getWalletChart(wallet);
      // Use the API response as-is without selecting inner fields
      rawChart = chartResp;
    } catch (e) {
      logger.warn('[dossier] wallet chart fetch failed:', e?.message || e);
    }

    // Raw artifact (gated internally by jsonArtifacts config)
    {
      const chartFullPath = artifacts.write('raw', 'chart', rawChart);
      if (chartFullPath) {
        logger.info(
          `[dossier] wrote raw chart (${Array.isArray(rawChart) ? rawChart.length : 0}) → ${chartFullPath}`,
        );
      }
    }
    {
      const fullPath = artifacts.write('raw', 'trades', rawTrades);
      if (fullPath) {
        logger.info(
          `[dossier] wrote raw trades (${rawTrades.length}) → ${fullPath}`,
        );
      }
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
      if (!isBase58Mint(mint)) {
        logger.debug(`[dossier] skipping non-base58 mint: ${mint}`);
        continue;
      }
      if (!seenMints.has(mint)) {
        seenMints.add(mint);
        // Also skip stable mints defensively (in case extractMint chose the stable leg)
        if (isStableMint(mint)) continue;
        lastMints.push(mint);
        if (lastMints.length >= featureMintCount) break;
      }
    }

    if (lastMints.length === 0) {
      const first = rawTrades[0];
      const keys = first ? Object.keys(first) : [];
      logger.warn('[dossier] mint derivation found 0 mints. Sample trade keys:', keys.join(','));
    } else {
      logger.debug(`[dossier] last ${lastMints.length}/${featureMintCount} mints: ${lastMints.join(', ')}`);
    }

    // 1.7) Fetch user-specific token trades for each mint (first page only, raw kept in dev)
    const mintTradesByMint = {};
    for (const mint of lastMints) {
      try {
        logger.debug('[dossier] fetching user-token-trades', {
          mint,
          owner: wallet,
          sortDirection: 'DESC',
        });

        const resp = await st.getUserTokenTrades(mint, wallet);

        const mintTrades = Array.isArray(resp?.trades)
          ? resp.trades
          : Array.isArray(resp?.data)
            ? resp.data
            : Array.isArray(resp)
              ? resp
              : [];
        const count = Array.isArray(mintTrades) ? mintTrades.length : 0;
        logger.debug(`[dossier] mint ${mint} user-trades fetched: ${count}`);

        // Raw artifact (gated internally)
        artifacts.write('raw', `${mint}-minttrades`, resp);

        // Add a trimmed slice to the merged payload (cap to 50 rows)
        mintTradesByMint[mint] = Array.isArray(mintTrades) ? mintTrades.slice(0, 50) : mintTrades;
      } catch (e) {
        const status = e?.status || e?.response?.status;
        const data = e?.response?.data || e?.data || e?.body;
        logger.warn(`[dossier] mint trades fetch failed for ${mint}:`, status ? `status ${status}` : '', data ? J(data) : (e?.message || e));
      }
    }

    // 2) Build merged payload for Responses job
    const meta = {
      wallet,
      traderName: traderName || null,   // human-readable (may contain spaces)
      traderAlias,                      // safe alias used for filenames and lookups
      startTime: startTime || null,
      endTime: endTime || null,
      fetchedAt: new Date().toISOString(),
      featureMintCount
    };
    const techniqueFeatures = buildTechniqueFeaturesFromMintMap(mintTradesByMint, featureMintCount);

    // Derive convenient coin-level slices for downstream analysis / prompts
    const coins = Array.isArray(techniqueFeatures?.coins) ? techniqueFeatures.coins : [];
    let topWinners = [];
    let topLosers = [];
    let bagholds = [];

    if (coins.length) {
      topWinners = [...coins]
        .filter((c) => typeof c.maxGainPct === 'number' && isFinite(c.maxGainPct))
        .sort((a, b) => b.maxGainPct - a.maxGainPct)
        .slice(0, 5);

      topLosers = [...coins]
        .filter((c) => typeof c.maxLossPct === 'number' && isFinite(c.maxLossPct))
        .sort((a, b) => a.maxLossPct - b.maxLossPct)
        .slice(0, 5);

      bagholds = coins.filter((c) => c.hasBag || c.isStoryCoin);
    }

    const walletStats = buildWalletStatsFromChart(rawChart);
    const regimeEvents = buildRegimeEventsFromChart(rawChart);

    const merged = {
      meta,
      trades: rawTrades,
      chart: rawChart,
      userTokenTradesByMint: mintTradesByMint,
      techniqueFeatures,
      coins,
      topWinners,
      topLosers,
      bagholds,
      walletStats,
      regimeEvents,
    };

    // Prompt payload (exactly what we send to the model)
    {
      const promptPath = artifacts.write('prompt', 'prompt', merged);
      if (promptPath) logger.info(`[dossier] wrote prompt payload → ${promptPath}`);
    }

    logger.debug('[dossier] merged sizes before analyze:', { trades: Array.isArray(rawTrades) ? rawTrades.length : -1, chart: Array.isArray(rawChart) ? rawChart.length : -1 });
    logger.info(`[dossier] feature mints requested: ${featureMintCount}`);

    // --- Harvest-only mode: return merged payload to orchestrator ---
    if (!runAnalysis) {
      logger.info('[dossier] runAnalysis=false (harvest-only mode)');
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

    // Response payload (exact model output)
    {
      const respPath = artifacts.write('response', 'response', openAiResult);
      if (respPath) logger.info(`[dossier] wrote response payload → ${respPath}`);
    }

    // 3.4/3.5) Persist analysis and profile snapshot using aiPersistence
    try {
      const analysisIdRaw = await requestId({ prefix: 'analysis' });
      const analysisId = String(analysisIdRaw).slice(-26);

      await persistWalletAnalysis({
        BootyBox,
        analysisRow: {
          analysisId,
          wallet,
          traderName: traderName || null,
          tradeCount: Array.isArray(rawTrades) ? rawTrades.length : 0,
          chartCount: Array.isArray(rawChart) ? rawChart.length : 0,
          merged,
          responseRaw: openAiResult,
          jsonVersion: openAiResult?.version || null,
        },
        logger,
      });

      await persistProfileSnapshot({
        BootyBox,
        profileId: analysisId,
        name: traderName || wallet,
        wallet,
        source: 'dossier',
        prompt: merged,
        response: openAiResult,
        logger,
      });
    } catch (persistErr) {
      // Non-fatal: analysis still returns to caller
      logger.warn('[dossier] failed to persist analysis:', persistErr?.message || persistErr);
    }

    logger.info('[dossier] analysis complete');
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
    logger.error('[dossier] error:', err?.message || err);
    throw err;
  } finally {
    if (st && typeof st.close === 'function') {
      try {
        await st.close();
      } catch (closeErr) {
        logger.warn('[dossier] failed to close SolanaTracker data client:', closeErr?.message || closeErr);
      }
    }
  }
}

module.exports = { harvestWallet };
