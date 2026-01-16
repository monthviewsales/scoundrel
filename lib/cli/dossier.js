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
/**
 * @typedef {Object} TechniqueFeatures
 * @description Summary features describing trading technique across mints.
 */
/**
 * @typedef {Object} MergedPayload
 * @property {{ wallet: string, traderName: (string|null), startTime: (number|null), endTime: (number|null), fetchedAt: string, featureMintCount: number }} meta
 * @property {ChartPoint[]|any[]} walletChart
 * @property {TechniqueFeatures} techniqueFeatures
 * @property {Array} [campaigns]
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
const { queueVectorStoreUpload } = require('../ai/vectorStoreUpload');
const { createAnalysisFlow } = require('./analysisFlow');
const { persistProfileSnapshot, persistWalletAnalysis } = require('../persist/aiPersistence');
const { normalizeTraderAlias } = require('../persist/jsonArtifacts');
const { buildMetaBlock, buildFinalPayload, buildMintCampaigns, pruneNullishPayload } = require('../analysis/payloadBuilders');
const logger = require('../logger');
const pkg = require('../../package.json');
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
 * Build a map of token metadata keyed by mint from wallet trades.
 * @param {Trade[]} trades
 * @returns {Object}
 */
function buildTokenMetaByMint(trades) {
  const out = {};
  if (!Array.isArray(trades)) return out;

  for (const t of trades) {
    const mint = extractMintFromTrade(t);
    if (!mint) continue;
    const from = t && t.from;
    const to = t && t.to;
    const token =
      (from && from.address === mint ? from.token : null) ||
      (to && to.address === mint ? to.token : null) ||
      null;
    if (!token || typeof token !== 'object') continue;

    const existing = out[mint] || {};
    out[mint] = {
      symbol: existing.symbol || token.symbol || null,
      name: existing.name || token.name || null,
      decimals: existing.decimals ?? token.decimals ?? null,
    };
  }

  return out;
}


const runDossierFlow = createAnalysisFlow({
  command: 'dossier',
  logger,
  build: async ({ options, createArtifacts }) => {
    const {
      wallet,
      traderName,
      startTime,
      endTime,
      limit = DEFAULT_LIMIT,
      featureMintCount = FEATURE_MINT_COUNT_DEFAULT,
      client,
    } = options;

    if (!wallet) throw new Error('[dossier] wallet is required');

    const traderAlias = normalizeTraderAlias(traderName, wallet);
    const runContext = createArtifacts([traderAlias]);

    const st = client || createSolanaTrackerDataClient();

    const rawTrades = await st.getWalletTrades({ wallet, startTime, endTime, limit });
    logger.debug(`[dossier] fetched ${rawTrades.length} raw trades`);

    if (!rawTrades.length) {
      return {
        payload: null,
        promptPath: null,
        runAnalysis: false,
        traderAlias,
        rawTrades,
        rawChart: [],
        meta: {
          wallet,
          traderName: traderName || null,
          traderAlias,
          startTime: startTime || null,
          endTime: endTime || null,
          fetchedAt: new Date().toISOString(),
          featureMintCount,
        },
      };
    }

    let rawChart = [];
    try {
      const chartResp = await st.getWalletChart(wallet);
      rawChart = chartResp;
    } catch (e) {
      logger.warn('[dossier] wallet chart fetch failed:', e?.message || e);
    }

    {
      const chartFullPath = runContext.artifacts.write('raw', 'chart', rawChart);
      if (chartFullPath) {
        logger.debug(
          `[dossier] wrote raw chart (${Array.isArray(rawChart) ? rawChart.length : 0}) → ${chartFullPath}`,
        );
      }
    }
    {
      const fullPath = runContext.artifacts.write('raw', 'trades', rawTrades);
      if (fullPath) {
        logger.debug(
          `[dossier] wrote raw trades (${rawTrades.length}) → ${fullPath}`,
        );
      }
    }

    const lastMints = [];
    const seenMints = new Set();
    for (const t of rawTrades) {
      if (isSolToStableSwap(t)) continue;
      const mint = extractMintFromTrade(t);
      if (!mint) continue;
      if (mint.toLowerCase && mint.toLowerCase() === 'mint') continue;
      if (!isBase58Mint(mint)) {
        logger.debug(`[dossier] skipping non-base58 mint: ${mint}`);
        continue;
      }
      if (!seenMints.has(mint)) {
        seenMints.add(mint);
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

        runContext.artifacts.write('raw', `${mint}-minttrades`, resp);

        mintTradesByMint[mint] = Array.isArray(mintTrades) ? mintTrades.slice(0, 50) : mintTrades;
      } catch (e) {
        const status = e?.status || e?.response?.status;
        const data = e?.response?.data || e?.data || e?.body;
        logger.warn(`[dossier] mint trades fetch failed for ${mint}:`, status ? `status ${status}` : '', data ? J(data) : (e?.message || e));
      }
    }

    const meta = buildMetaBlock({
      command: 'dossier',
      runId: runContext.runId,
      mode: 'wallet',
      scoundrelVersion: pkg.version,
      fetchedAt: new Date().toISOString(),
      wallet,
      traderName: traderName || null,
      traderAlias,
      startTime: startTime || null,
      endTime: endTime || null,
      featureMintCount,
    });
    const techniqueFeatures = buildTechniqueFeaturesFromMintMap(mintTradesByMint, featureMintCount);

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
    const tokenMetaByMint = buildTokenMetaByMint(rawTrades);

    const campaigns = buildMintCampaigns({
      walletLabel: traderName || traderAlias,
      walletAddress: wallet,
      mintTradesByMint,
      coinStats: coins,
      tokenMetaByMint,
    });

    const merged = pruneNullishPayload({
      meta,
      campaigns,
      walletChart: rawChart,
      techniqueFeatures,
      topWinners,
      topLosers,
      bagholds,
      walletStats,
      regimeEvents,
    });

    logger.debug('[dossier] input sizes before analyze:', {
      rawTrades: Array.isArray(rawTrades) ? rawTrades.length : -1,
      walletChart: Array.isArray(rawChart) ? rawChart.length : -1,
    });
    logger.debug(`[dossier] feature mints requested: ${featureMintCount}`);

    return {
      payload: merged,
      meta,
      rawTrades,
      rawChart,
      techniqueFeatures,
      traderAlias,
      artifacts: runContext.artifacts,
    };
  },
  analyze: async ({ payload }) => analyzeWallet({
    merged: payload,
    purpose: 'Analyze this wallet\'s trades and chart and return the schema-locked JSON.'
  }),
  persist: async ({ payload, analysis, buildResult }) => {
    try {
      const analysisIdRaw = await requestId({ prefix: 'analysis' });
      const analysisId = String(analysisIdRaw).slice(-26);
      const finalPayload = buildFinalPayload({ prompt: payload, response: analysis });
      let finalPath = null;
      if (buildResult?.artifacts) {
        const traderLabel = buildResult?.meta?.traderName
          || buildResult?.meta?.traderAlias
          || buildResult?.meta?.wallet
          || 'trader';
        const finalPrefix = `dossier_${traderLabel}_final`;
        finalPath = buildResult.artifacts.write('final', finalPrefix, finalPayload);
      }
      await queueVectorStoreUpload({
        source: 'dossier',
        name: buildResult?.meta?.traderName || buildResult?.meta?.wallet || null,
        attributes: {
          source: 'dossier',
          wallet: buildResult?.meta?.wallet || null,
          traderName: buildResult?.meta?.traderName || null,
          traderAlias: buildResult?.meta?.traderAlias || null,
        },
        jsonPath: finalPath || null,
        data: finalPath ? null : finalPayload,
      }).catch((err) => logger.warn('[dossier] vector store ingest failed:', err?.message));

      await persistWalletAnalysis({
        BootyBox,
        analysisRow: {
          analysisId,
          wallet: buildResult.meta.wallet,
          traderName: buildResult.meta.traderName,
          tradeCount: Array.isArray(buildResult.rawTrades) ? buildResult.rawTrades.length : 0,
          chartCount: Array.isArray(buildResult.rawChart) ? buildResult.rawChart.length : 0,
          merged: payload,
          responseRaw: analysis,
          jsonVersion: analysis?.version || null,
        },
        logger,
      });

      await persistProfileSnapshot({
        BootyBox,
        profileId: analysisId,
        name: buildResult.meta.traderName || buildResult.meta.wallet,
        wallet: buildResult.meta.wallet,
        source: 'dossier',
        profile: finalPayload,
        logger,
      });
    } catch (persistErr) {
      logger.warn('[dossier] failed to persist analysis:', persistErr?.message || persistErr);
    }
  },
});

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
  logger.debug(`[dossier] start wallet=${wallet} trader=${traderName || 'N/A'} start=${startTime || 'N/A'} end=${endTime || 'N/A'} limit=${limit} concurrency=${concurrency}`);

  if (!wallet) throw new Error('[dossier] wallet is required');

  let st;
  try {
    st = createSolanaTrackerDataClient();
    const flowResult = await runDossierFlow({
      wallet,
      traderName,
      startTime,
      endTime,
      limit,
      concurrency,
      includeOutcomes,
      featureMintCount,
      runAnalysis,
      client: st,
    });

    if (!flowResult.payload) {
      return {
        wallet,
        startTime: startTime || null,
        endTime: endTime || null,
        count: 0,
        openAiResult: [],
        enriched: null,
      };
    }

    if (!runAnalysis) {
      logger.debug('[dossier] runAnalysis=false (harvest-only mode)');
      return {
        wallet,
        traderName: flowResult.buildResult.meta.traderName,
        startTime: flowResult.buildResult.meta.startTime,
        endTime: flowResult.buildResult.meta.endTime,
        count: Array.isArray(flowResult.buildResult.rawTrades) ? flowResult.buildResult.rawTrades.length : 0,
        errors: 0,
        merged: flowResult.payload,
        techniqueFeatures: flowResult.buildResult.techniqueFeatures,
      };
    }

    logger.debug('[dossier] analysis complete');
    return {
      wallet,
      traderName: flowResult.buildResult.meta.traderName,
      startTime: flowResult.buildResult.meta.startTime,
      endTime: flowResult.buildResult.meta.endTime,
      count: Array.isArray(flowResult.buildResult.rawTrades) ? flowResult.buildResult.rawTrades.length : 0,
      errors: 0,
      enriched: null,
      openAiResult: flowResult.analysis,
      merged: flowResult.payload,
      techniqueFeatures: flowResult.buildResult.techniqueFeatures,
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
