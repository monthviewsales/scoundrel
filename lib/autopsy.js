'use strict';

const fs = require('fs');
const path = require('path');
const { createSolanaTrackerDataClient } = require('./solanaTrackerDataClient');
const { analyzeTradeAutopsy } = require('../ai/jobs/tradeAutopsy');
const log = require('./log');
const { query } = require('./db/mysql');
const { requestId } = require('./id/issuer');
const pkg = require('../package.json');

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
  const candidates = [trade.price?.sol, trade.price?.usd, trade.price, trade.executionPrice];
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
  const holdDurationSeconds = first != null && last != null ? Math.max(0, last - first) : null;
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

async function ensureTokenInfo(mint, client) {
  try {
    const { rows } = await query('SELECT * FROM coins WHERE mint = ? LIMIT 1', [mint]);
    if (rows && rows.length) return rows[0];
  } catch (err) {
    log.warn('[autopsy] coins lookup failed, fetching from API instead', err?.message || err);
  }

  const info = await client.getTokenInformation(mint);
  try {
    const payload = {
      mint,
      symbol: info?.symbol || null,
      name: info?.name || null,
      decimals: info?.decimals != null ? info.decimals : null,
      data: JSON.stringify(info || {}),
    };
    await query(
      `INSERT INTO coins (mint, symbol, name, decimals, data)
       VALUES (:mint, :symbol, :name, :decimals, CAST(:data AS JSON))
       ON DUPLICATE KEY UPDATE symbol = VALUES(symbol), name = VALUES(name), decimals = VALUES(decimals), data = VALUES(data)`,
      payload,
    );
  } catch (err) {
    log.warn('[autopsy] failed to persist token info:', err?.message || err);
  }
  return info;
}

async function fetchCandles(client, mint, startTimestamp, endTimestamp) {
  const windowStart = Math.max(0, startTimestamp - 300);
  const windowEnd = endTimestamp + 300;
  const candles = await client.getTokenOhlcvData({
    mint,
    type: '1m',
    timeFrom: windowStart,
    timeTo: windowEnd,
    removeOutliers: true,
  });

  const rows = Array.isArray(candles?.candles) ? candles.candles : Array.isArray(candles) ? candles : [];
  if (rows.length <= MAX_CANDLES) {
    return { granularity: '1m', startTimestamp: windowStart, endTimestamp: windowEnd, candles: rows };
  }
  const step = Math.ceil(rows.length / MAX_CANDLES);
  const downsampled = rows.filter((_, idx) => idx % step === 0);
  return { granularity: '1m', startTimestamp: windowStart, endTimestamp: windowEnd, candles: downsampled };
}

function saveArtifact(payload, aiResult) {
  const dir = path.join(process.cwd(), 'profiles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const symbol = (payload.token.symbol || 'token').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const walletSafe = (payload.wallet.address || 'wallet').slice(0, 6);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `autopsy-${walletSafe}-${symbol}-${ts}.json`;
  const outPath = path.join(dir, fname);
  const finalPayload = { ...payload, ai: aiResult };
  fs.writeFileSync(outPath, JSON.stringify(finalPayload, null, 2));
  return outPath;
}

async function persistRunMeta({ payload, aiResult }) {
  try {
    const autopsyIdRaw = await requestId({ prefix: 'autopsy' });
    const autopsyId = String(autopsyIdRaw).slice(-26);
    await query(
      `INSERT INTO sc_profiles (
        profile_id, name, wallet, profile, source
      ) VALUES (
        :profile_id, :name, :wallet, CAST(:profile AS JSON), :source
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        wallet = VALUES(wallet),
        profile = VALUES(profile),
        source = VALUES(source)` ,
      {
        profile_id: autopsyId,
        name: payload.wallet.label || payload.wallet.address,
        wallet: payload.wallet.address,
        profile: JSON.stringify({ ...payload, ai: aiResult }),
        source: 'autopsy',
      },
    );
    if (process.env.NODE_ENV === 'development') {
      log.info(`[autopsy] persisted autopsy as ${autopsyId}`);
    }
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

  const client = createSolanaTrackerDataClient();
  const tokenInfo = await ensureTokenInfo(mint, client);
  const allTrades = await client.getWalletTrades({ wallet: walletAddress, limit: 1000 });
  const mintTrades = Array.isArray(allTrades) ? allTrades.filter((t) => t && (t.mint === mint || t.tokenMint === mint || t.mintAddress === mint || t.token?.mint === mint || t.token?.address === mint || t.base?.mint === mint || t.quote?.mint === mint)) : [];

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

  const [priceRange, tokenPnL, athPrice] = await Promise.all([
    client.getPriceRange(mint, startTimestamp, endTimestamp),
    client.getTokenPnL({ wallet: walletAddress, tokenAddress: mint, holdingCheck: true }),
    client.getAthPrice(mint),
  ]);

  const ochlvWindow = await fetchCandles(client, mint, startTimestamp, endTimestamp);

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

  const ai = await analyzeTradeAutopsy({ payload });
  const artifactPath = saveArtifact(payload, ai);
  await persistRunMeta({ payload, aiResult: ai });

  console.log('\n=== Autopsy Narrative ===\n');
  console.log(JSON.stringify(ai, null, 2));
  console.log(`\n[autopsy] saved artifact to ${artifactPath}`);
  return { payload, ai, artifactPath };
}

module.exports = { runAutopsy };
