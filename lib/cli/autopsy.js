'use strict';

const logger = require('../../lib/logger');
const { persistProfileSnapshot, persistTradeAutopsy } = require('../persist/aiPersistence');
const BootyBox = require('../../db');
const pkg = require('../../package.json');
const { requestId } = require('../id/issuer');
const { ensureTokenInfo } = require('../services/tokenInfoService');
const { analyzeTradeAutopsy } = require('../../ai/jobs/tradeAutopsy');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const {
  createArtifactWriter,
  formatRunId,
  sanitizeSegment,
} = require('../persist/jsonArtifacts');

const { createCommandRun } = require('./aiRun');

const MAX_CANDLES = 500;

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

  await BootyBox.init();

  const client = providedClient || createSolanaTrackerDataClient();
  const shouldCloseClient = !providedClient && client && typeof client.close === 'function';

  let resolvedWalletLabel = walletLabel;
  let resolvedWalletAddress = walletAddress;
  let resolvedMint = mint;
  let payload;
  let ai;
  let artifactPath;

  try {
    const buildResult = isDbMode
      ? await buildAutopsyPayloadFromTradeUuid({ tradeUuid, client })
      : await buildAutopsyPayload({ walletLabel, walletAddress, mint, client });

    payload = buildResult.payload;
    if (isDbMode) {
      resolvedWalletLabel = buildResult.walletLabel;
      resolvedWalletAddress = buildResult.walletAddress;
      resolvedMint = buildResult.mint;
    }

    const walletSafe = sanitizeSegment(resolvedWalletLabel || resolvedWalletAddress || 'wallet');
    const mintSafe = sanitizeSegment(resolvedMint || 'mint', 'mint');

    const { runId, artifacts } = createCommandRun({
      command: 'autopsy',
      segments: [walletSafe, mintSafe],
      logger,
      runId: buildResult.runId,
    });

    // Prompt/response artifacts (gated internally by jsonArtifacts config)
    artifacts.write('prompt', 'prompt', payload);

    ai = await analyzeTradeAutopsy({ payload });

    artifactPath = artifacts.write('response', 'response', ai) || '';

    const autopsyId = String(await requestId({ prefix: 'autopsy' })).slice(-26);

    await persistProfileSnapshot({
      BootyBox,
      profileId: autopsyId,
      name: payload.wallet.label || payload.wallet.address,
      wallet: payload.wallet.address,
      source: 'autopsy',
      prompt: payload,
      response: ai,
      logger,
    });

    await persistTradeAutopsy({
      BootyBox,
      autopsyRow: {
        autopsyId,
        wallet: resolvedWalletAddress,
        mint: resolvedMint,
        symbol: payload.token.symbol || null,
        payload,
        responseRaw: ai,
        jsonVersion: ai?.version || null,
      },
      logger,
    });

    printAutopsyToConsole({
      walletLabel: resolvedWalletLabel,
      walletAddress: resolvedWalletAddress,
      mint: resolvedMint,
      aiResult: ai,
    });

    if (artifactPath) logger.info(`\n[autopsy] saved response artifact to ${artifactPath}`);
    return { payload, ai, artifactPath };
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
 * @returns {Promise<Object>}
 */
async function buildAutopsyPayload({
  walletLabel,
  walletAddress,
  mint,
  client,
  runId,
}) {
  if (!walletAddress || !mint) {
    throw new Error('[autopsy] walletAddress and mint are required to build payload');
  }

  const resolvedRunId = runId || formatRunId();
  const resolvedClient = client || createSolanaTrackerDataClient();
  const walletSafe = sanitizeSegment(walletLabel || walletAddress || 'wallet');
  const mintSafe = sanitizeSegment(mint || 'mint', 'mint');
  const artifacts = createArtifactWriter({
    command: 'autopsy',
    segments: [walletSafe, mintSafe],
    runId: resolvedRunId,
    logger,
  });

  const tokenInfo = await ensureTokenInfo({ mint, client: resolvedClient });
  artifacts.write('raw', 'tokenInfo', { tokenInfo });

  const tradeResp = await resolvedClient.getUserTokenTrades(mint, walletAddress);
  artifacts.write('raw', 'userTokenTrades', {
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

  const [priceRange, tokenPnL, athPrice] = await Promise.all([
    resolvedClient.getPriceRange(mint, startTimestamp, endTimestamp),
    resolvedClient.getTokenPnL({ wallet: walletAddress, tokenAddress: mint, holdingCheck: true }),
    resolvedClient.getAthPrice(mint),
  ]);

  injectPnLPercent(metrics, tokenPnL);

  const ochlvWindow = await fetchCandles({
    client: resolvedClient,
    mint,
    startTimestamp,
    endTimestamp,
    runId: resolvedRunId,
    artifacts,
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

  // Prompt payload (enriched input to AI)
  artifacts.write('prompt', 'prompt', payload);

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
  };
}

/**
 * Build the payload for a DB campaign identified by trade UUID.
 *
 * @param {Object} params
 * @param {string} params.tradeUuid
 * @param {Object} [params.client]
 * @param {string} [params.runId]
 * @returns {Promise<Object>}
 */
async function buildAutopsyPayloadFromTradeUuid({ tradeUuid, client, runId }) {
  if (!tradeUuid) {
    throw new Error('[autopsy] tradeUuid is required to build payload from DB');
  }

  const resolvedRunId = runId || formatRunId();
  await BootyBox.init();

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
  const artifacts = createArtifactWriter({
    command: 'autopsy',
    segments: [walletSafe, mintSafe],
    runId: resolvedRunId,
    logger,
  });

  const resolvedClient = client || createSolanaTrackerDataClient();
  const tokenInfo = await ensureTokenInfo({ mint, client: resolvedClient });
  artifacts.write('raw', 'tokenInfo', { tokenInfo });
  const mintTrades = normalizeDbTradesToAutopsyTrades(dbTrades);
  if (!mintTrades.length) {
    throw new Error(`[autopsy] No usable trades found in DB for trade_uuid ${tradeUuid}`);
  }

  artifacts.write('raw', 'dbTrades', { tradeUuid: String(tradeUuid).trim(), trades: dbTrades });

  const timestamps = mintTrades.map(extractTimestamp).filter((v) => v != null);
  if (!timestamps.length) {
    throw new Error('[autopsy] no timestamps found for DB trades');
  }

  const startTimestamp = Math.min(...timestamps);
  const endTimestamp = Math.max(...timestamps);
  const metrics = computeCampaignMetrics(mintTrades, walletAddress);

  const [priceRange, tokenPnL, athPrice] = await Promise.all([
    resolvedClient.getPriceRange(mint, startTimestamp, endTimestamp),
    resolvedClient.getTokenPnL({ wallet: walletAddress, tokenAddress: mint, holdingCheck: true }),
    resolvedClient.getAthPrice(mint),
  ]);

  injectPnLPercent(metrics, tokenPnL);

  const ochlvWindow = await fetchCandles({
    client: resolvedClient,
    mint,
    startTimestamp,
    endTimestamp,
    runId: resolvedRunId,
    artifacts,
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

  artifacts.write('prompt', 'prompt', payload);

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
async function fetchCandles({ client, mint, startTimestamp, endTimestamp, runId, artifacts }) {
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

  const rows = rawRows.map((row) => ({ t: row.time, o: row.open, c: row.close, l: row.low, h: row.high, v: row.volume }));
  if (rows.length <= MAX_CANDLES) {
    return { granularity: '1m', startTimestamp: windowStart * 1000, endTimestamp: windowEnd * 1000, candles: rows };
  }

  const step = Math.ceil(rows.length / MAX_CANDLES);
  const downsampled = rows.filter((_, idx) => idx % step === 0);
  return { granularity: '1m', startTimestamp: windowStart * 1000, endTimestamp: windowEnd * 1000, candles: downsampled };
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
  const realizedPnLSol =
    sells.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 0)), 0) -
    buys.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 0)), 0) -
    feesPaidSol;

  return {
    realizedPnLSol,
    realizedPnLPercent: null,
    avgEntryPrice,
    avgExitPrice,
    holdDurationSeconds,
    maxPriceAfterEntry: null,
    minPriceAfterEntry: null,
    feesPaidSol,
    feeToPnLRatio: feesPaidSol !== 0 ? realizedPnLSol / feesPaidSol : null,
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
function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractTimestamp(trade) {
  if (!trade) return null;
  const candidates = [trade.blockTime, trade.block_time, trade.timestamp, trade.time, trade.ts];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return null;
}

function extractSide(trade, wallet) {
  if (!trade) return null;
  if (typeof trade.type === 'string') {
    const t = trade.type.toLowerCase();
    if (t === 'buy' || t === 'sell') return t;
  }
  if (typeof trade.side === 'string') return trade.side.toLowerCase();
  if (trade.direction) return String(trade.direction).toLowerCase();
  if (trade.from && trade.from.address === wallet) return 'sell';
  if (trade.to && trade.to.address === wallet) return 'buy';
  return null;
}

function extractAmount(trade) {
  if (!trade) return null;
  const candidates = [trade.amount, trade.tokenAmount, trade.quantity, trade.size, trade.volume?.token, trade.volume?.amount];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return null;
}

function extractPrice(trade) {
  if (!trade) return null;
  const candidates = [trade.priceUsd, trade.price_usd, trade.price?.usd, trade.price?.sol, trade.price, trade.executionPrice];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return null;
}

function extractFees(trade) {
  if (!trade) return 0;
  const candidates = [trade.fee, trade.fees, trade.feePaid, trade.feeUsd, trade.feeSol, trade.totalFee, trade.totalFees, trade.fee?.sol, trade.fee?.usd];
  for (const val of candidates) {
    const n = parseNumber(val);
    if (n != null) return n;
  }
  return 0;
}

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
  const campaign = {
    trades: mintTrades,
    startTimestamp,
    endTimestamp,
    metrics,
  };
  if (tradeUuid) campaign.tradeUuid = tradeUuid;

  return {
    wallet: { label: walletLabel, address: walletAddress },
    token: {
      mint,
      symbol: tokenInfo?.symbol,
      name: tokenInfo?.name,
      decimals: tokenInfo?.decimals,
      tokenInfo,
    },
    campaign,
    marketContext: { priceRange, tokenPnL, athPrice, ochlvWindow },
    meta: {
      createdAt: new Date().toISOString(),
      scoundrelVersion: pkg.version,
      command: 'autopsy',
      mode,
      runId,
    },
  };
}

module.exports = { runAutopsy, buildAutopsyPayload, buildAutopsyPayloadFromTradeUuid };
