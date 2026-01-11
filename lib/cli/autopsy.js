'use strict';

const logger = require('../../lib/logger');
const { persistProfileSnapshot, persistTradeAutopsy } = require('../persist/aiPersistence');
const BootyBox = require('../../db');
const pkg = require('../../package.json');
const { requestId } = require('../id/issuer');
const { ensureBootyBoxInit } = require('../bootyBoxInit');
const { ensureTokenInfo } = require('../services/tokenInfoService');
const { analyzeTradeAutopsy } = require('../../ai/jobs/tradeAutopsy');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const { queueVectorStoreUpload } = require('../ai/vectorStoreUpload');
const { resolveAutopsyWallet } = require('./autopsyWalletResolver');
const {
  buildMetaBlock,
  buildCampaignContext,
  buildTokenSummary,
  buildMarketOverview,
  buildTokenSnapshotSummary,
  buildFinalPayload,
  pruneNullishPayload,
} = require('../analysis/payloadBuilders');
const { buildOhlcvContext } = require('../analysis/ohlcvContext');
const {
  extractTimestamp,
  extractSide,
  extractAmount,
  extractPrice,
  extractFees,
} = require('../autopsy/tradeExtractors');
const {
  createArtifactWriter,
  formatRunId,
  sanitizeSegment,
  normalizeTraderAlias,
} = require('../persist/jsonArtifacts');

const { createAnalysisFlow } = require('./analysisFlow');

const MAX_CANDLES = 500;

/**
 * Fetch market snapshots at the start/end of the campaign window.
 *
 * @param {Object} params
 * @param {Object} params.client
 * @param {string} params.mint
 * @param {number} params.startTimestamp
 * @param {number} params.endTimestamp
 * @param {Object} [params.artifacts]
 * @returns {Promise<Object|null>}
 */
async function fetchMarketSnapshots({ client, mint, startTimestamp, endTimestamp, artifacts }) {
  if (!client || typeof client.getTokenSnapshotAt !== 'function') return null;

  const startSec = Math.floor(startTimestamp / 1000);
  const endSec = Math.floor(endTimestamp / 1000);
  const result = {
    startTimestamp,
    endTimestamp,
    start: null,
    end: null,
  };

  try {
    const startSnapshot = await client.getTokenSnapshotAt({ mint, timestamp: startSec });
    result.start = buildTokenSnapshotSummary(startSnapshot);
    if (artifacts) {
      artifacts.write('raw', 'snapshot-start', {
        request: { mint, timestamp: startSec },
        response: startSnapshot,
      });
    }
  } catch (err) {
    result.start = { error: err?.message || String(err) };
  }

  try {
    const endSnapshot = await client.getTokenSnapshotAt({ mint, timestamp: endSec });
    result.end = buildTokenSnapshotSummary(endSnapshot);
    if (artifacts) {
      artifacts.write('raw', 'snapshot-end', {
        request: { mint, timestamp: endSec },
        response: endSnapshot,
      });
    }
  } catch (err) {
    result.end = { error: err?.message || String(err) };
  }

  return result;
}

const runAutopsyFlow = createAnalysisFlow({
  command: 'autopsy',
  logger,
  build: async ({ options, createArtifacts }) => {
    const { tradeUuid, walletLabel, walletAddress, mint, client } = options;
    const isDbMode = Boolean(tradeUuid);

    let buildResult;
    if (isDbMode) {
      buildResult = await buildAutopsyPayloadFromTradeUuid({
        tradeUuid,
        client,
        createArtifacts,
      });
    } else {
      const walletSafe = sanitizeSegment(walletLabel || walletAddress || 'wallet');
      const mintSafe = sanitizeSegment(mint || 'mint', 'mint');
      const runContext = createArtifacts([walletSafe, mintSafe]);
      buildResult = await buildAutopsyPayload({
        walletLabel,
        walletAddress,
        mint,
        client,
        runId: runContext.runId,
        artifacts: runContext.artifacts,
      });
    }

    return {
      payload: buildResult.payload,
      ...buildResult,
    };
  },
  analyze: async ({ payload }) => analyzeTradeAutopsy({ payload }),
  persist: async ({ payload, analysis, buildResult }) => {
    const autopsyId = String(await requestId({ prefix: 'autopsy' })).slice(-26);
    const campaignWallet = payload?.campaign?.wallet || {};
    const campaignToken = payload?.campaign?.token || {};
    const finalPayload = buildFinalPayload({ prompt: payload, response: analysis });
    let finalPath = null;
    if (buildResult?.artifacts) {
      const tokenLabel = campaignToken.name
        || campaignToken.symbol
        || buildResult?.mint
        || payload?.meta?.mint
        || 'token';
      const finalPrefix = `autopsy_${tokenLabel}_final`;
      finalPath = buildResult.artifacts.write('final', finalPrefix, finalPayload);
    }
    await queueVectorStoreUpload({
      source: 'autopsy',
      name: campaignToken.symbol || buildResult?.mint || payload?.meta?.mint || null,
      jsonPath: finalPath || null,
      data: finalPath ? null : finalPayload,
    }).catch((err) => logger.warn('[autopsy] vector store ingest failed:', err?.message));
    await persistProfileSnapshot({
      BootyBox,
      profileId: autopsyId,
      name: campaignWallet.label || campaignWallet.address,
      wallet: campaignWallet.address,
      source: 'autopsy',
      profile: finalPayload,
      logger,
    });

    await persistTradeAutopsy({
      BootyBox,
      autopsyRow: {
        autopsyId,
        wallet: buildResult.walletAddress,
        mint: buildResult.mint,
        symbol: campaignToken.symbol || null,
        payload,
        responseRaw: analysis,
        jsonVersion: analysis?.version || null,
      },
      logger,
    });
  },
});

/**
 * Entry point for the CLI `autopsy` command. Builds the payload, submits it to
 * the AI job, persists artifacts, and prints a friendly summary.
 *
 * @param {Object} params
 * @param {string} [params.tradeUuid]     Optional DB trade UUID (DB mode).
 * @param {string} [params.walletLabel]   Wallet label for API mode.
 * @param {string} [params.walletAddress] Wallet address for API mode.
 * @param {string} [params.mint]          Mint address for API mode.
 * @param {Object} [params.client]        Optional shared SolanaTracker client.
 * @returns {Promise<{ payload: Object, ai: Object, artifactPath: string }>}
 */
async function runAutopsy({ tradeUuid, walletLabel, walletAddress, mint, client: providedClient }) {
  const isDbMode = Boolean(tradeUuid);
  if (!isDbMode && (!walletAddress || !mint)) {
    throw new Error('[autopsy] walletAddress and mint are required');
  }

  const client = providedClient || createSolanaTrackerDataClient();
  const shouldCloseClient = !providedClient && client && typeof client.close === 'function';

  let resolvedWalletLabel = walletLabel;
  let resolvedWalletAddress = walletAddress;
  let resolvedMint = mint;
  let result;

  try {
    if (!isDbMode) {
      const resolved = await resolveAutopsyWallet({
        walletLabel: resolvedWalletLabel,
        walletAddress: resolvedWalletAddress,
      });
      resolvedWalletLabel = resolved.walletLabel;
      resolvedWalletAddress = resolved.walletAddress;
    }

    result = await runAutopsyFlow({
      tradeUuid,
      walletLabel: resolvedWalletLabel,
      walletAddress: resolvedWalletAddress,
      mint: resolvedMint,
      client,
    });

    resolvedWalletLabel = result.buildResult?.walletLabel || resolvedWalletLabel;
    resolvedWalletAddress = result.buildResult?.walletAddress || resolvedWalletAddress;
    resolvedMint = result.buildResult?.mint || resolvedMint;

    printAutopsyToConsole({
      walletLabel: resolvedWalletLabel,
      walletAddress: resolvedWalletAddress,
      mint: resolvedMint,
      aiResult: result.analysis,
    });

    if (result.responsePath) {
      logger.info(`\n[autopsy] saved response artifact to ${result.responsePath}`);
    }

    return { payload: result.payload, ai: result.analysis, artifactPath: result.responsePath || '' };
  } finally {
    if (shouldCloseClient) {
      try {
        await client.close();
      } catch (err) {
        logger.warn('[autopsy] failed to close SolanaTracker data client:', err?.message || err);
      }
    }
  }
}

/**
 * Build the enriched payload for a wallet + mint campaign via SolanaTracker APIs.
 *
 * @param {Object} params
 * @param {string} params.walletLabel
 * @param {string} params.walletAddress
 * @param {string} params.mint
 * @param {Object} [params.client]
 * @param {string} [params.runId]
 * @param {Object} [params.artifacts]
 * @returns {Promise<Object>}
 */
async function buildAutopsyPayload({
  walletLabel,
  walletAddress,
  mint,
  client,
  runId,
  artifacts,
}) {
  if (!walletAddress || !mint) {
    throw new Error('[autopsy] walletAddress and mint are required to build payload');
  }

  const resolvedRunId = runId || formatRunId();
  const resolvedClient = client || createSolanaTrackerDataClient();
  const walletSafe = sanitizeSegment(walletLabel || walletAddress || 'wallet');
  const mintSafe = sanitizeSegment(mint || 'mint', 'mint');
  const resolvedArtifacts = artifacts || createArtifactWriter({
    command: 'autopsy',
    segments: [walletSafe, mintSafe],
    runId: resolvedRunId,
    logger,
  });

  const tokenInfo = await ensureTokenInfo({ mint, client: resolvedClient });
  resolvedArtifacts.write('raw', 'tokenInfo', { tokenInfo });

  const tradeResp = await resolvedClient.getUserTokenTrades(mint, walletAddress);
  resolvedArtifacts.write('raw', 'userTokenTrades', {
    request: { mint, walletAddress },
    response: tradeResp,
  });

  const mintTrades = extractMintTradesFromResponse(tradeResp);
  if (!mintTrades.length) {
    throw new Error(`[autopsy] No trades found for mint ${mint} in wallet ${walletAddress}`);
  }

  const timestamps = mintTrades.map(extractTimestamp).filter((v) => v != null);
  if (!timestamps.length) {
    throw new Error('[autopsy] no timestamps found for mint trades');
  }

  const startTimestamp = Math.min(...timestamps);
  const endTimestamp = Math.max(...timestamps);
  const metrics = computeCampaignMetrics(mintTrades, walletAddress);

  const [priceRange, tokenPnL, athPrice, marketSnapshot] = await Promise.all([
    resolvedClient.getPriceRange(mint, startTimestamp, endTimestamp),
    resolvedClient.getTokenPnL({ wallet: walletAddress, tokenAddress: mint, holdingCheck: true }),
    resolvedClient.getAthPrice(mint),
    fetchMarketSnapshots({
      client: resolvedClient,
      mint,
      startTimestamp,
      endTimestamp,
      artifacts: resolvedArtifacts,
    }),
  ]);

  injectPnLPercent(metrics, tokenPnL);

  const ochlvWindow = await fetchCandles({
    client: resolvedClient,
    mint,
    startTimestamp,
    endTimestamp,
    runId: resolvedRunId,
    artifacts: resolvedArtifacts,
    marketSnapshot,
  });

  const payload = createAutopsyPayload({
    walletLabel,
    walletAddress,
    mint,
    tokenInfo,
    mintTrades,
    startTimestamp,
    endTimestamp,
    metrics,
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow,
    runId: resolvedRunId,
    mode: 'wallet_mint',
  });

  return {
    payload,
    tokenInfo,
    mintTrades,
    metrics,
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow,
    runId: resolvedRunId,
    walletLabel,
    walletAddress,
    mint,
    artifacts: resolvedArtifacts,
  };
}

/**
 * Build the payload for a DB campaign identified by trade UUID.
 *
 * @param {Object} params
 * @param {string} params.tradeUuid
 * @param {Object} [params.client]
 * @param {string} [params.runId]
 * @param {Object} [params.artifacts]
 * @param {Function} [params.createArtifacts]
 * @returns {Promise<Object>}
 */
async function buildAutopsyPayloadFromTradeUuid({
  tradeUuid,
  client,
  runId,
  artifacts,
  createArtifacts,
}) {
  if (!tradeUuid) {
    throw new Error('[autopsy] tradeUuid is required to build payload from DB');
  }

  const resolvedRunId = runId || formatRunId();
  await ensureBootyBoxInit();

  if (typeof BootyBox.getTradesByTradeUuid !== 'function') {
    throw new Error('[autopsy] BootyBox.getTradesByTradeUuid is not available');
  }

  const dbTrades = BootyBox.getTradesByTradeUuid(String(tradeUuid).trim(), { order: 'asc' });
  if (!dbTrades.length) {
    throw new Error(`[autopsy] No sc_trades rows found for trade_uuid ${tradeUuid}`);
  }

  const mint = dbTrades[0].coin_mint;
  const walletLabel = dbTrades[0].wallet_alias || `wallet_id:${dbTrades[0].wallet_id}`;
  const walletAddress = await resolveWalletAddressFromTrades(dbTrades);
  if (!walletAddress) {
    throw new Error(
      `[autopsy] Cannot resolve wallet address for trade_uuid ${tradeUuid}. ` +
        'Ensure your wallet registry can be looked up via BootyBox (getWalletById/getWalletByAlias) or store wallet address with trades.'
    );
  }

  const walletSafe = sanitizeSegment(walletLabel || walletAddress || 'wallet');
  const mintSafe = sanitizeSegment(mint || 'mint', 'mint');
  const resolvedArtifacts = artifacts
    || (typeof createArtifacts === 'function'
      ? createArtifacts([walletSafe, mintSafe], resolvedRunId).artifacts
      : createArtifactWriter({
          command: 'autopsy',
          segments: [walletSafe, mintSafe],
          runId: resolvedRunId,
          logger,
        }));

  const resolvedClient = client || createSolanaTrackerDataClient();
  const tokenInfo = await ensureTokenInfo({ mint, client: resolvedClient });
  resolvedArtifacts.write('raw', 'tokenInfo', { tokenInfo });
  const mintTrades = normalizeDbTradesToAutopsyTrades(dbTrades);
  if (!mintTrades.length) {
    throw new Error(`[autopsy] No usable trades found in DB for trade_uuid ${tradeUuid}`);
  }

  resolvedArtifacts.write('raw', 'dbTrades', { tradeUuid: String(tradeUuid).trim(), trades: dbTrades });

  const timestamps = mintTrades.map(extractTimestamp).filter((v) => v != null);
  if (!timestamps.length) {
    throw new Error('[autopsy] no timestamps found for DB trades');
  }

  const startTimestamp = Math.min(...timestamps);
  const endTimestamp = Math.max(...timestamps);
  const metrics = computeCampaignMetrics(mintTrades, walletAddress);

    const [priceRange, tokenPnL, athPrice, marketSnapshot] = await Promise.all([
      resolvedClient.getPriceRange(mint, startTimestamp, endTimestamp),
      resolvedClient.getTokenPnL({ wallet: walletAddress, tokenAddress: mint, holdingCheck: true }),
      resolvedClient.getAthPrice(mint),
      fetchMarketSnapshots({
        client: resolvedClient,
        mint,
        startTimestamp,
        endTimestamp,
        artifacts: resolvedArtifacts,
      }),
    ]);

  injectPnLPercent(metrics, tokenPnL);

    const ochlvWindow = await fetchCandles({
      client: resolvedClient,
      mint,
      startTimestamp,
      endTimestamp,
      runId: resolvedRunId,
      artifacts: resolvedArtifacts,
      marketSnapshot,
    });

  const payload = createAutopsyPayload({
    walletLabel,
    walletAddress,
    mint,
    tokenInfo,
    mintTrades,
    startTimestamp,
    endTimestamp,
    metrics,
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow,
    runId: resolvedRunId,
    mode: 'trade_uuid',
    tradeUuid: String(tradeUuid).trim(),
  });

  return {
    payload,
    tokenInfo,
    mintTrades,
    metrics,
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow,
    runId: resolvedRunId,
    walletLabel,
    walletAddress,
    mint,
    artifacts: resolvedArtifacts,
  };
}

/**
 * Fetch and normalize OHLCV candles for the campaign window.
 *
 * @param {Object} params
 * @param {Object} params.client
 * @param {string} params.mint
 * @param {number} params.startTimestamp
 * @param {number} params.endTimestamp
 * @param {string} params.runId
 * @param {Object} [params.artifacts]
 * @returns {Promise<Object>}
 */
async function fetchCandles({ client, mint, startTimestamp, endTimestamp, runId, artifacts, marketSnapshot }) {
  const startSec = Math.floor(startTimestamp / 1000);
  const endSec = Math.floor(endTimestamp / 1000);
  const windowStart = Math.max(0, startSec - 5 * 60);
  const windowEnd = endSec + 5 * 60;

  const params = {
    mint,
    type: '1m',
    timeFrom: windowStart,
    timeTo: windowEnd,
    removeOutliers: true,
  };

  const candlesResp = await client.getTokenOhlcvData(params);
  if (artifacts) {
    artifacts.write('raw', 'ohlcv', { request: params, response: candlesResp });
  }

  const rawRows = Array.isArray(candlesResp?.oclhv)
    ? candlesResp.oclhv
    : Array.isArray(candlesResp?.candles)
      ? candlesResp.candles
      : Array.isArray(candlesResp?.data)
        ? candlesResp.data
        : Array.isArray(candlesResp)
          ? candlesResp
          : [];

  const rows = rawRows.map((row) => ({
    t: row.time,
    o: row.open,
    c: row.close,
    l: row.low,
    h: row.high,
    v: row.volume,
  }));
  const outputStart = windowStart * 1000;
  const outputEnd = windowEnd * 1000;

  if (rows.length <= MAX_CANDLES) {
    return buildOhlcvContext({
      granularity: '1m',
      startTimestamp: outputStart,
      endTimestamp: outputEnd,
      candles: rows,
      marketSnapshot,
    });
  }

  const step = Math.ceil(rows.length / MAX_CANDLES);
  const downsampled = rows.filter((_, idx) => idx % step === 0);
  return buildOhlcvContext({
    granularity: '1m',
    startTimestamp: outputStart,
    endTimestamp: outputEnd,
    candles: downsampled,
    indicatorCandles: rows,
    marketSnapshot,
  });
}

/**
 * Compute aggregate metrics for the campaign (PnL, position, timing, fees).
 *
 * @param {Object[]} trades
 * @param {string} wallet
 * @returns {Object}
 */
function computeCampaignMetrics(trades, wallet) {
  const buys = [];
  const sells = [];
  trades.forEach((t) => {
    const side = extractSide(t, wallet);
    const amt = extractAmount(t);
    const price = extractPrice(t);
    if (side === 'sell') {
      sells.push({ amt, price });
    } else if (side === 'buy') {
      buys.push({ amt, price });
    }
  });

  const totalBought = buys.reduce((sum, t) => sum + (t.amt || 0), 0);
  const totalSold = sells.reduce((sum, t) => sum + (t.amt || 0), 0);
  const avgEntryPrice = buys.length
    ? buys.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 1)), 0) / buys.reduce((sum, t) => sum + (t.amt || 1), 0)
    : null;
  const avgExitPrice = sells.length
    ? sells.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 1)), 0) / sells.reduce((sum, t) => sum + (t.amt || 1), 0)
    : null;

  const timestamps = trades.map(extractTimestamp).filter((v) => v != null);
  const first = timestamps.length ? Math.min(...timestamps) : null;
  const last = timestamps.length ? Math.max(...timestamps) : null;
  const holdDurationSeconds = first != null && last != null ? Math.max(0, Math.round((last - first) / 1000)) : null;
  const feesPaidSol = trades.reduce((sum, t) => sum + extractFees(t), 0);
  const realizedPnLUsd =
    sells.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 0)), 0) -
    buys.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 0)), 0) -
    feesPaidSol;

  return {
    realizedPnLUsd,
    realizedPnLPercent: null,
    avgEntryPrice,
    avgExitPrice,
    holdDurationSeconds,
    maxPriceAfterEntry: null,
    minPriceAfterEntry: null,
    feesPaidSol,
    feeToPnLRatio: feesPaidSol !== 0 ? realizedPnLUsd / feesPaidSol : null,
    netPosition: totalBought - totalSold,
    totalBought,
    totalSold,
  };
}



/**
 * Render the AI result to stdout in a human-friendly way.
 *
 * @param {Object} params
 * @param {string} params.walletLabel
 * @param {string} params.walletAddress
 * @param {string} params.mint
 * @param {Object} params.aiResult
 */
function printAutopsyToConsole({ walletLabel, walletAddress, mint, aiResult }) {
  if (!aiResult || typeof aiResult !== 'object') return;

  const {
    grade,
    gradeReason,
    summary,
    entryAnalysis,
    exitAnalysis,
    riskManagement,
    profitability,
    whereYouLeftEV,
    lessons,
    tags,
    idealReplay,
  } = aiResult;

  const header = walletLabel ? `${walletLabel} (${shortenPubkey(walletAddress) || walletAddress || ''})` : walletAddress || '';

  // eslint-disable-next-line no-console
  console.log('\n=== Trade Autopsy ===\n');
  if (header || mint) {
    // eslint-disable-next-line no-console
    console.log(`Wallet: ${header || 'n/a'}`);
    // eslint-disable-next-line no-console
    console.log(`Mint  : ${mint}`);
    // eslint-disable-next-line no-console
    console.log('');
  }

  if (grade) {
    // eslint-disable-next-line no-console
    console.log(`Grade: ${grade}${gradeReason ? ` — ${gradeReason}` : ''}`);
    // eslint-disable-next-line no-console
    console.log('');
  }

  const sections = [
    ['Summary', summary],
    ['Entry Analysis', entryAnalysis],
    ['Exit Analysis', exitAnalysis],
    ['Risk Management', riskManagement],
    ['Profitability', profitability],
    ['Where You Left EV', whereYouLeftEV],
  ];

  sections.forEach(([label, content]) => {
    if (!content) return;
    // eslint-disable-next-line no-console
    console.log(`${label}:\n`);
    // eslint-disable-next-line no-console
    console.log(normalizeText(content));
    // eslint-disable-next-line no-console
    console.log('');
  });

  // Ideal Replay section
  if (idealReplay && typeof idealReplay === 'object') {
    const irSummary = idealReplay.summary;
    const irPct = idealReplay.projectedProfitPercent;
    const irTechniques = idealReplay.keyTechniques;

    if (irSummary || irPct != null || (Array.isArray(irTechniques) && irTechniques.length)) {
      // eslint-disable-next-line no-console
      console.log('Ideal Replay:\n');

      if (irSummary) {
        // eslint-disable-next-line no-console
        console.log('Summary:\n');
        // eslint-disable-next-line no-console
        console.log(normalizeText(irSummary));
        // eslint-disable-next-line no-console
        console.log('');
      }

      if (irPct != null && irPct !== '') {
        const pctNum = Number(irPct);
        const pctDisplay = Number.isFinite(pctNum) ? `${pctNum.toFixed(2)}%` : `${irPct}%`;
        // eslint-disable-next-line no-console
        console.log(`Projected Profit: ${pctDisplay}`);
        // eslint-disable-next-line no-console
        console.log('');
      }

      if (Array.isArray(irTechniques) && irTechniques.length) {
        // eslint-disable-next-line no-console
        console.log('Key Techniques:\n');
        irTechniques.forEach((line, idx) => {
          // eslint-disable-next-line no-console
          console.log(`  ${idx + 1}. ${line}`);
        });
        // eslint-disable-next-line no-console
        console.log('');
      }
    }
  }

  if (Array.isArray(lessons) && lessons.length) {
    // eslint-disable-next-line no-console
    console.log('Key Lessons:\n');
    lessons.forEach((line, idx) => {
      // eslint-disable-next-line no-console
      console.log(`  ${idx + 1}. ${line}`);
    });
    // eslint-disable-next-line no-console
    console.log('');
  }

  if (Array.isArray(tags) && tags.length) {
    // eslint-disable-next-line no-console
    console.log('Tags:', tags.join(', '));
    // eslint-disable-next-line no-console
    console.log('');
  }
}


// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
function extractMintTradesFromResponse(tradeResp) {
  if (Array.isArray(tradeResp?.trades)) return tradeResp.trades;
  if (Array.isArray(tradeResp?.data)) return tradeResp.data;
  if (Array.isArray(tradeResp)) return tradeResp;
  return [];
}

function injectPnLPercent(metrics, tokenPnL) {
  if (
    tokenPnL &&
    typeof tokenPnL.realized === 'number' &&
    typeof tokenPnL.total_invested === 'number' &&
    tokenPnL.total_invested > 0
  ) {
    metrics.realizedPnLPercent = (tokenPnL.realized / tokenPnL.total_invested) * 100;
  }
}

function normalizeDbTradesToAutopsyTrades(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    tx: r.txid,
    type: r.side,
    side: r.side,
    amount: r.token_amount,
    volumeSol: r.sol_amount,
    priceUsd: r.price_usd_per_token,
    time: r.executed_at,
    __db: {
      id: r.id,
      trade_uuid: r.trade_uuid,
      wallet_id: r.wallet_id,
      wallet_alias: r.wallet_alias,
      coin_mint: r.coin_mint,
    },
  }));
}

async function resolveWalletAddressFromTrades(dbTrades) {
  const first = Array.isArray(dbTrades) && dbTrades.length ? dbTrades[0] : null;
  if (!first) return null;

  const direct = first.wallet_address || first.walletAddress || first.wallet_pubkey || first.walletPubkey || first.pubkey;
  if (direct) return String(direct).trim();

  const walletAlias = first.wallet_alias;
  if (!walletAlias) return null;

  if (typeof BootyBox.getWarchestWalletByAlias !== 'function') {
    throw new Error('[autopsy] BootyBox.getWarchestWalletByAlias is not available');
  }

  const w = await BootyBox.getWarchestWalletByAlias(String(walletAlias).trim());
  const addr = w && (w.pubkey || w.address || w.wallet_address || w.publicKey);
  return addr ? String(addr).trim() : null;
}

// ---------------------------------------------------------------------------
// Primitive extractors and formatters
// ---------------------------------------------------------------------------
function shortenPubkey(address) {
  if (!address) return '';
  const s = String(address);
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function normalizeText(text) {
  if (!text) return '';
  return String(text).replace(/\\n/g, '\n');
}

function createAutopsyPayload({
  walletLabel,
  walletAddress,
  mint,
  tokenInfo,
  mintTrades,
  startTimestamp,
  endTimestamp,
  metrics,
  priceRange,
  tokenPnL,
  athPrice,
  ochlvWindow,
  runId,
  mode,
  tradeUuid,
}) {
  const traderName = walletLabel ? String(walletLabel) : null;
  const traderAlias = normalizeTraderAlias(walletLabel || null, walletAddress);
  const tokenSummary = buildTokenSummary(tokenInfo);
  const marketOverview = buildMarketOverview(tokenInfo);

  const campaign = buildCampaignContext({
    walletLabel,
    walletAddress,
    mint,
    tokenInfo,
    tokenSummary,
    includeTokenInfo: false,
    trades: mintTrades,
    startTimestamp,
    endTimestamp,
    metrics,
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow,
    marketOverview,
  });

  const meta = buildMetaBlock({
    command: 'autopsy',
    runId,
    mode,
    scoundrelVersion: pkg.version,
    wallet: walletAddress,
    walletLabel,
    traderName,
    traderAlias,
    mint,
    tradeUuid,
    startTime: startTimestamp,
    endTime: endTimestamp,
  });

  const compactMeta = {
    ...meta,
    mint: null,
    developerWallet: null,
    developerTokensWallet: null,
    tradeUuid: meta.tradeUuid || null,
    targets: meta.tradeUuid ? { tradeUuid: meta.tradeUuid } : null,
  };

  return pruneNullishPayload({
    meta: compactMeta,
    campaign,
  });
}

module.exports = { runAutopsy, buildAutopsyPayload, buildAutopsyPayloadFromTradeUuid };
