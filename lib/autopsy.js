'use strict';

const fs = require('fs');
const path = require('path');
const { createSolanaTrackerDataClient } = require('./solanaTrackerDataClient');
const { analyzeTradeAutopsy } = require('../ai/jobs/tradeAutopsy');
const log = require('./log');
const BootyBox = require('./db/BootyBox.mysql');
const { ensureTokenInfo } = require('./services/tokenInfoService');
const { requestId } = require('./id/issuer');
const pkg = require('../package.json');
const {
  autopsyBaseDir,
  formatRunId,
  getArtifactConfig,
  sanitizeSegment,
  writeJsonArtifact: writeArtifact,
} = require('./persist/jsonArtifacts');

const artifactConfig = getArtifactConfig();
const { saveRaw: SAVE_RAW, saveParsed: SAVE_PARSED, saveEnriched: SAVE_ENRICHED } = artifactConfig;

const MAX_CANDLES = 500;

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

  // SolanaTracker trades use "type": "buy" | "sell"
  if (typeof trade.type === 'string') {
    const t = trade.type.toLowerCase();
    if (t === 'buy' || t === 'sell') return t;
  }

  if (typeof trade.side === 'string') return trade.side.toLowerCase();
  if (trade.direction) return String(trade.direction).toLowerCase();
  // Heuristic: if from.address matches wallet, treat as sell
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
  const candidates = [
    trade.priceUsd,
    trade.price_usd,
    trade.price?.usd,
    trade.price?.sol,
    trade.price,
    trade.executionPrice,
  ];
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
  // If the string has literal "\n" sequences, unescape them to real newlines
  return String(text).replace(/\\n/g, '\n');
}

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
  } = aiResult;

  const header = walletLabel
    ? `${walletLabel} (${shortenPubkey(walletAddress) || walletAddress || ''})`
    : walletAddress || '';

  console.log('\n=== Trade Autopsy ===\n');

  if (header || mint) {
    console.log(`Wallet: ${header || 'n/a'}`);
    console.log(`Mint  : ${mint}`);
    console.log('');
  }

  if (grade) {
    console.log(`Grade: ${grade}${gradeReason ? ` — ${gradeReason}` : ''}`);
    console.log('');
  }

  if (summary) {
    console.log('Summary:\n');
    console.log(normalizeText(summary));
    console.log('');
  }

  if (entryAnalysis) {
    console.log('Entry Analysis:\n');
    console.log(normalizeText(entryAnalysis));
    console.log('');
  }

  if (exitAnalysis) {
    console.log('Exit Analysis:\n');
    console.log(normalizeText(exitAnalysis));
    console.log('');
  }

  if (riskManagement) {
    console.log('Risk Management:\n');
    console.log(normalizeText(riskManagement));
    console.log('');
  }

  if (profitability) {
    console.log('Profitability:\n');
    console.log(normalizeText(profitability));
    console.log('');
  }

  if (whereYouLeftEV) {
    console.log('Where You Left EV:\n');
    console.log(normalizeText(whereYouLeftEV));
    console.log('');
  }

  if (Array.isArray(lessons) && lessons.length) {
    console.log('Key Lessons:\n');
    lessons.forEach((line, idx) => {
      console.log(`  ${idx + 1}. ${line}`);
    });
    console.log('');
  }

  if (Array.isArray(tags) && tags.length) {
    console.log('Tags:', tags.join(', '));
    console.log('');
  }
}

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
  const avgEntryPrice = buys.length ? buys.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 1)), 0) / buys.reduce((sum, t) => sum + (t.amt || 1), 0) : null;
  const avgExitPrice = sells.length ? sells.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 1)), 0) / sells.reduce((sum, t) => sum + (t.amt || 1), 0) : null;
  const netPosition = totalBought - totalSold;
  const timestamps = trades.map(extractTimestamp).filter((v) => v != null);
  const first = timestamps.length ? Math.min(...timestamps) : null;
  const last = timestamps.length ? Math.max(...timestamps) : null;
  const holdDurationSeconds = first != null && last != null ? Math.max(0, Math.round((last - first) / 1000)) : null;
  const feesPaidSol = trades.reduce((sum, t) => sum + extractFees(t), 0);
  const realizedPnLSol = sells.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 0)), 0) - buys.reduce((sum, t) => sum + ((t.price || 0) * (t.amt || 0)), 0) - feesPaidSol;
  const feeToPnLRatio = feesPaidSol !== 0 ? realizedPnLSol / feesPaidSol : null;

  return {
    realizedPnLSol,
    realizedPnLPercent: null,
    avgEntryPrice,
    avgExitPrice,
    holdDurationSeconds,
    maxPriceAfterEntry: null,
    minPriceAfterEntry: null,
    feesPaidSol,
    feeToPnLRatio,
    netPosition,
    totalBought,
    totalSold,
  };
}


async function fetchCandles({ client, mint, startTimestamp, endTimestamp, baseDir, runId }) {
  // startTimestamp / endTimestamp come in as ms; convert to seconds and pad +/- 5 minutes
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

  // Optionally persist raw OHLCV response for debugging
  if (SAVE_RAW) {
    try {
      writeArtifact(
        baseDir,
        ['raw'],
        `ohlcv-${runId}.json`,
        { request: params, response: candlesResp },
      );
    } catch (err) {
      log.warn('[autopsy] failed to write RAW ohlcv artifact:', err?.message || err);
    }
  }

  // SolanaTracker OHLCV comes back as an "oclhv" array: open, close, low, high, volume, time (secs)
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
    // normalize to a consistent shape for AI usage
    t: row.time,
    o: row.open,
    c: row.close,
    l: row.low,
    h: row.high,
    v: row.volume,
  }));

  if (rows.length <= MAX_CANDLES) {
    return {
      granularity: '1m',
      startTimestamp: windowStart * 1000,
      endTimestamp: windowEnd * 1000,
      candles: rows,
    };
  }

  const step = Math.ceil(rows.length / MAX_CANDLES);
  const downsampled = rows.filter((_, idx) => idx % step === 0);
  return {
    granularity: '1m',
    startTimestamp: windowStart * 1000,
    endTimestamp: windowEnd * 1000,
    candles: downsampled,
  };
}

function saveArtifact(payload, aiResult, { runId, walletSafe, mintSafe }) {
  const dir = path.join(process.cwd(), 'profiles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const symbolSafe = sanitizeSegment(payload.token.symbol || 'token');
  const fname = `autopsy-${walletSafe}-${mintSafe || symbolSafe}-${runId}.json`;
  const outPath = path.join(dir, fname);
  const finalPayload = { ...payload, ai: aiResult };
  fs.writeFileSync(outPath, JSON.stringify(finalPayload, null, 2));
  return outPath;
}

async function persistRunMeta({ payload, aiResult, autopsyId }) {
  try {
    const autopsyIdRaw = autopsyId || await requestId({ prefix: 'autopsy' });
    const resolvedId = String(autopsyIdRaw).slice(-26);
    await BootyBox.init();
    await BootyBox.upsertProfileSnapshot({
      profileId: resolvedId,
      name: payload.wallet.label || payload.wallet.address,
      wallet: payload.wallet.address,
      profile: { ...payload, ai: aiResult },
      source: 'autopsy',
    });
    if (process.env.NODE_ENV === 'development') {
      log.info(`[autopsy] persisted autopsy as ${resolvedId}`);
    }
    return resolvedId;
  } catch (err) {
    log.warn('[autopsy] failed to persist autopsy record:', err?.message || err);
  }
}

/**
 * Run a trade autopsy for a single wallet + mint campaign.
 *
 * @param {Object} params
 * @param {string} params.walletLabel   Human-friendly label or "other".
 * @param {string} params.walletAddress Base58 wallet pubkey.
 * @param {string} params.mint          Token mint address.
 * @returns {Promise<{ payload: Object, ai: Object, artifactPath: string }>} Artifact path and AI output.
 */
async function runAutopsy({ walletLabel, walletAddress, mint }) {
  if (!walletAddress || !mint) {
    throw new Error('[autopsy] walletAddress and mint are required');
  }

  const runId = formatRunId();
  const walletSafe = sanitizeSegment(walletLabel || walletAddress || 'wallet');
  const mintSafe = sanitizeSegment(mint, 'mint');
  const baseDir = autopsyBaseDir(walletAddress || walletLabel, mint);
  const client = createSolanaTrackerDataClient();

  await BootyBox.init();

  const tokenInfo = await ensureTokenInfo({ mint, client });

  // Optionally save token metadata for this mint
  if (SAVE_RAW) {
    try {
      writeArtifact(baseDir, ['raw'], `tokenInfo-${runId}.json`, { tokenInfo });
    } catch (err) {
      log.warn('[autopsy] failed to write RAW tokenInfo artifact:', err?.message || err);
    }
  }

  // Use the wallet+mint specific userTokenTrades API from the SolanaTracker Data client
  // instead of the legacy HTTP integration.
  const tradeResp = await client.getUserTokenTrades(mint, walletAddress);

  // Optionally save raw userTokenTrades API response
  if (SAVE_RAW) {
    try {
      writeArtifact(
        baseDir,
        ['raw'],
        `userTokenTrades-${runId}.json`,
        {
          request: { mint, walletAddress },
          response: tradeResp,
        },
      );
    } catch (err) {
      log.warn('[autopsy] failed to write RAW userTokenTrades artifact:', err?.message || err);
    }
  }

  const mintTrades = Array.isArray(tradeResp?.trades)
    ? tradeResp.trades
    : Array.isArray(tradeResp?.data)
      ? tradeResp.data
      : Array.isArray(tradeResp)
        ? tradeResp
        : [];

  if (process.env.NODE_ENV === 'development') {
    log.info(
      `[autopsy] fetched ${Array.isArray(mintTrades) ? mintTrades.length : 0} userTokenTrades for wallet ${walletAddress} mint ${mint}`,
    );
  }

  if (!mintTrades.length) {
    console.log(`[autopsy] No trades found for mint ${mint} in wallet ${walletAddress}`);
    return null;
  }

  const timestamps = mintTrades.map((t) => extractTimestamp(t)).filter((v) => v != null);
  if (!timestamps.length) {
    throw new Error('[autopsy] no timestamps found for mint trades');
  }
  const startTimestamp = Math.min(...timestamps);
  const endTimestamp = Math.max(...timestamps);
  const metrics = computeCampaignMetrics(mintTrades, walletAddress);

  // Optionally save parsed campaign snapshot (no marketContext/meta yet)
  if (SAVE_PARSED) {
    try {
      const parsedSnapshot = {
        wallet: { label: walletLabel, address: walletAddress },
        token: {
          mint,
          symbol: tokenInfo?.symbol,
          name: tokenInfo?.name,
          decimals: tokenInfo?.decimals,
        },
        campaign: {
          trades: mintTrades,
          startTimestamp,
          endTimestamp,
          metrics,
        },
      };
      writeArtifact(baseDir, ['parsed'], `campaign-${runId}.json`, parsedSnapshot);
    } catch (err) {
      log.warn('[autopsy] failed to write PARSED campaign artifact:', err?.message || err);
    }
  }

  const [priceRange, tokenPnL, athPrice] = await Promise.all([
    client.getPriceRange(mint, startTimestamp, endTimestamp),
    client.getTokenPnL({ wallet: walletAddress, tokenAddress: mint, holdingCheck: true }),
    client.getAthPrice(mint),
  ]);

  // Use canonical PnL from SolanaTracker to populate percent return
  if (
    tokenPnL &&
    typeof tokenPnL.realized === 'number' &&
    typeof tokenPnL.total_invested === 'number' &&
    tokenPnL.total_invested > 0
  ) {
    metrics.realizedPnLPercent = (tokenPnL.realized / tokenPnL.total_invested) * 100;
  }

  const ochlvWindow = await fetchCandles({
    client,
    mint,
    startTimestamp,
    endTimestamp,
    baseDir,
    runId,
  });
  const payload = {
    wallet: { label: walletLabel, address: walletAddress },
    token: {
      mint,
      symbol: tokenInfo?.symbol,
      name: tokenInfo?.name,
      decimals: tokenInfo?.decimals,
      tokenInfo,
    },
    campaign: {
      trades: mintTrades,
      startTimestamp,
      endTimestamp,
      metrics,
    },
    marketContext: {
      priceRange,
      tokenPnL,
      athPrice,
      ochlvWindow,
    },
    meta: {
      createdAt: new Date().toISOString(),
      scoundrelVersion: pkg.version,
      command: 'autopsy',
    },
  };

  // Optionally save enriched (AI input) payload
  if (SAVE_ENRICHED) {
    try {
      writeArtifact(baseDir, ['enriched'], `autopsyPayload-${runId}.json`, payload);
    } catch (err) {
      log.warn('[autopsy] failed to write ENRICHED autopsy payload artifact:', err?.message || err);
    }
  }

  const ai = await analyzeTradeAutopsy({ payload });
  const artifactPath = saveArtifact(payload, ai, { runId, walletSafe, mintSafe });
  const autopsyIdRaw = await requestId({ prefix: 'autopsy' });
  const autopsyId = String(autopsyIdRaw).slice(-26);
  await persistRunMeta({ payload, aiResult: ai, autopsyId });
  try {
    await BootyBox.init();
    await BootyBox.recordTradeAutopsy({
      autopsyId,
      wallet: walletAddress,
      mint,
      symbol: tokenInfo?.symbol || null,
      payload,
      responseRaw: ai,
      jsonVersion: ai?.version || null,
    });
  } catch (err) {
    log.warn('[autopsy] failed to persist autopsy record:', err?.message || err);
  }

  printAutopsyToConsole({
    walletLabel,
    walletAddress,
    mint,
    aiResult: ai,
  });

  console.log(`\n[autopsy] saved artifact to ${artifactPath}`);
  return { payload, ai, artifactPath };
}

module.exports = { runAutopsy };
