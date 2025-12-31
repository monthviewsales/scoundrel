'use strict';

const { db: contextDb } = require('../adapters/sqlite');
const {
  computeRsi,
  computeAtr,
  computeSlopePct,
  computeEmaSeries,
  computeEmaSeriesAll,
  computeMacd,
  computeVwap,
} = require('./indicators');

/**
 * Evaluation Service
 *
 * Purpose:
 * - Build a complete, DB-backed evaluation snapshot for a wallet position (trade_uuid).
 * - Keep this logic in the DB layer so multiple apps (warchest, bots, CLI) can reuse it.
 *
 * Notes:
 * - This module does NOT schedule or trigger evaluations. Callers decide when to run it.
 * - This module is read-only today (build snapshot). Persistence can be added later.
 */

// --------------------------
// Defaults / policy
// --------------------------

const DEFAULT_EVENT_INTERVALS = ['5m', '15m', '1h'];

const DEFAULT_FRESHNESS = {
  coin: 2 * 60 * 1000, // 2 minutes
  pool: 2 * 60 * 1000, // 2 minutes
  events: 2 * 60 * 1000, // 2 minutes
  risk: 10 * 60 * 1000, // 10 minutes
};

// Chart/TA defaults (opt-in)
const DEFAULT_OHLCV = {
  type: '5m',
  lookbackMs: 6 * 60 * 60 * 1000, // 6 hours
  fastCache: true,
  removeOutliers: true,
};

const DEFAULT_INDICATORS = {
  rsiPeriod: 14,
  atrPeriod: 14,
  slopePeriods: 30, // number of candles to fit a simple trend slope

  // EMA/MACD
  emaFast: 12,
  emaSlow: 26,
  macdSignal: 9,

  // VWAP
  vwapPeriods: null, // null = full lookback; or set a number of candles (e.g. 60 for last 60 minutes on 1m)
};

// --------------------------
// DB helpers
// --------------------------

function normalizeRows(result) {
  // mysql2: [rows, fields]
  // some adapters: { rows }
  // some: rows
  if (Array.isArray(result)) {
    if (Array.isArray(result[0])) return result[0];
    return result;
  }
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.result)) return result.result;
  return [];
}

async function dbQuery(db, sql, params) {
  const resolvedDb = db || contextDb;
  if (!resolvedDb) throw new Error('evaluationService requires a sqlite db handle');

  // Preferred: better-sqlite3 style
  if (typeof resolvedDb.prepare === 'function') {
    const stmt = resolvedDb.prepare(sql);
    const rows = stmt.all(params || []);
    return rows;
  }

  // Compatibility: mysql2-like / wrapper-like adapters
  if (typeof resolvedDb.query === 'function') {
    return resolvedDb.query(sql, params);
  }
  if (typeof resolvedDb.execute === 'function') {
    return resolvedDb.execute(sql, params);
  }

  throw new Error('db handle does not support prepare(), query(), or execute()');
}

function isStale(tsMs, maxAgeMs, nowMs) {
  const ts = Number(tsMs || 0);
  if (!ts) return true;
  return (nowMs - ts) > maxAgeMs;
}

// --------------------------
// Loaders
// --------------------------

async function loadCoin(db, mint) {
  const sql = `
    SELECT *
    FROM coins
    WHERE mint = ?
    LIMIT 1
  `;

  const res = await dbQuery(db, sql, [mint]);
  const rows = normalizeRows(res);
  return rows && rows.length ? rows[0] : null;
}

async function loadBestPool(db, mint) {
  const sql = `
    SELECT *
    FROM pools
    WHERE coin_mint = ?
    ORDER BY COALESCE(liquidity_usd, 0) DESC,
             COALESCE(lastUpdated, 0) DESC
    LIMIT 1
  `;

  const res = await dbQuery(db, sql, [mint]);
  const rows = normalizeRows(res);
  return rows && rows.length ? rows[0] : null;
}

async function loadLatestEventsByInterval(db, mint, intervals) {
  const wanted = Array.isArray(intervals) && intervals.length ? intervals : DEFAULT_EVENT_INTERVALS;
  const placeholders = wanted.map(() => '?').join(',');

  const sql = `
    SELECT *
    FROM events
    WHERE coin_mint = ?
      AND interval IN (${placeholders})
    ORDER BY interval ASC,
             COALESCE(updatedAt, 0) DESC
  `;

  const res = await dbQuery(db, sql, [mint, ...wanted]);
  const rows = normalizeRows(res);

  // Keep the most recent row per interval
  const byInterval = {};
  for (const row of rows) {
    if (!row || !row.interval) continue;
    if (!byInterval[row.interval]) {
      byInterval[row.interval] = row;
    }
  }

  return byInterval;
}

async function loadRisk(db, mint) {
  const sql = `
    SELECT *
    FROM risk
    WHERE coin_mint = ?
    LIMIT 1
  `;

  const res = await dbQuery(db, sql, [mint]);
  const rows = normalizeRows(res);
  return rows && rows.length ? rows[0] : null;
}

async function loadPnlPositionLive(db, { walletId, coinMint, tradeUuid }) {
  if (!tradeUuid) return null;

  const sql = `
    SELECT *
    FROM sc_pnl_positions_live
    WHERE wallet_id = ?
      AND coin_mint = ?
      AND trade_uuid = ?
    LIMIT 1
  `;

  const res = await dbQuery(db, sql, [walletId, coinMint, tradeUuid]);
  const rows = normalizeRows(res);
  return rows && rows.length ? rows[0] : null;
}

// --------------------------
// Derived metrics
// --------------------------

function computeDerived({ position, coin, pool, pnl }) {
  const priceUsd = Number(coin?.priceUsd || coin?.price_usd || 0);

  const currentTokenAmount = position?.currentTokenAmount ?? position?.current_token_amount ?? null;
  const currentTokenAmountNum = currentTokenAmount == null ? null : Number(currentTokenAmount);

  const positionValueUsd = priceUsd && currentTokenAmountNum != null
    ? currentTokenAmountNum * priceUsd
    : null;

  // Cost basis from pnl view (preferred)
  const avgCostUsd = pnl?.avg_cost_usd != null ? Number(pnl.avg_cost_usd) : null;
  const basisTokenAmount = pnl?.position_token_amount != null ? Number(pnl.position_token_amount) : null;
  const costBasisUsd = avgCostUsd != null && basisTokenAmount != null
    ? avgCostUsd * basisTokenAmount
    : null;

  const unrealUsd = pnl?.unrealized_usd != null ? Number(pnl.unrealized_usd) : null;
  const totalUsd = pnl?.total_usd != null ? Number(pnl.total_usd) : null;

  const roiUnrealizedPct = costBasisUsd && unrealUsd != null
    ? (unrealUsd / costBasisUsd) * 100
    : null;

  const roiTotalPct = costBasisUsd && totalUsd != null
    ? (totalUsd / costBasisUsd) * 100
    : null;

  const liquidityUsd =
    (pool?.liquidity_usd != null ? Number(pool.liquidity_usd) : null) ??
    (coin?.liquidityUsd != null ? Number(coin.liquidityUsd) : null) ??
    (coin?.liquidity_usd != null ? Number(coin.liquidity_usd) : null) ??
    null;

  const liquidityToPositionRatio = liquidityUsd && positionValueUsd
    ? liquidityUsd / positionValueUsd
    : null;

  return {
    positionValueUsd,
    costBasisUsd,
    roiUnrealizedPct,
    roiTotalPct,
    liquidityToPositionRatio,
  };
}

// --------------------------
// OHLCV + indicators
// --------------------------

function pickNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandle(c) {
  if (!c || typeof c !== 'object') return null;

  // Common field aliases
  const t = pickNumber(c.t ?? c.time ?? c.ts ?? c.timestamp ?? c.startTime ?? c.start);
  const o = pickNumber(c.o ?? c.open);
  const h = pickNumber(c.h ?? c.high);
  const l = pickNumber(c.l ?? c.low);
  const cl = pickNumber(c.c ?? c.close);
  const v = pickNumber(c.v ?? c.volume ?? c.vol);

  if (o == null || h == null || l == null || cl == null) return null;

  // NOTE: t is preserved as provided (SolanaTracker often returns UNIX seconds).
  return { t, o, h, l, c: cl, v };
}

function normalizeOhlcvResponse(resp) {
  if (!resp) return [];

  // SolanaTracker responses vary by wrapper; support a few shapes.
  const data =
    (Array.isArray(resp?.oclhv) ? resp.oclhv : null) ||
    (Array.isArray(resp) ? resp : null) ||
    (Array.isArray(resp.data) ? resp.data : null) ||
    (Array.isArray(resp.ohlcv) ? resp.ohlcv : null) ||
    (Array.isArray(resp.result) ? resp.result : null) ||
    [];

  const out = [];
  for (const row of data) {
    const c = normalizeCandle(row);
    if (c) out.push(c);
  }

  // Ensure ascending time order if timestamps exist.
  out.sort((a, b) => (a.t || 0) - (b.t || 0));
  return out;
}

async function fetchTokenPoolOhlcv({ dataClient, mint, poolAddress, type, timeFrom, timeTo, fastCache, removeOutliers, timezone, marketCap }) {
  const sdkClient = dataClient?.client;
  if (!sdkClient || typeof sdkClient.getPoolChartData !== 'function') {
    throw new Error('dataClient must expose .client.getPoolChartData(...)');
  }

  return sdkClient.getPoolChartData({
    tokenAddress: mint,
    poolAddress,
    type,
    timeFrom,
    timeTo,
    fastCache,
    removeOutliers,
    timezone,
    marketCap,
  });
}

// --------------------------
// Public API
// --------------------------

/**
 * Build a complete evaluation snapshot for a trade/position.
 *
 * @param {Object} args
 * @param {*} [args.db] - Optional DB handle; defaults to sqlite context db
 * @param {Object} args.position - Position summary (schema-aware)
 * @param {*} [args.dataClient] - SolanaTracker Data API client wrapper (must expose .client.getPoolChartData)
 * @param {Object} [args.ohlcv] - OHLCV options (type/lookbackMs/fastCache/removeOutliers/timezone/marketCap)
 * @param {Object} [args.indicators] - Indicator options (rsiPeriod/atrPeriod/slopePeriods/emaFast/emaSlow/macdSignal/vwapPeriods)
 * @param {boolean} [args.includeCandles] - When true, include normalized candles in evaluation.chart.candles
 * @param {number} [args.nowMs] - Override current time (ms)
 * @param {string[]} [args.eventIntervals] - intervals to load (default 5m/15m/1h)
 * @param {Object} [args.freshness] - overrides for freshness windows (ms)
 * @returns {Promise<{evaluation: Object, warnings: string[]}>}
 */
async function buildEvaluation({
  db,
  position,
  dataClient,
  nowMs,
  eventIntervals,
  freshness,
  ohlcv,
  indicators,
  includeCandles,
}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const windows = { ...DEFAULT_FRESHNESS, ...(freshness || {}) };
  const intervals = Array.isArray(eventIntervals) && eventIntervals.length
    ? eventIntervals
    : DEFAULT_EVENT_INTERVALS;

  const warnings = [];

  const resolvedDb = db || contextDb;
  if (!resolvedDb) {
    throw new Error('buildEvaluation requires a sqlite db from context or args.db');
  }

  // ---- Coin ----
  const coin = await loadCoin(resolvedDb, position.mint);
  if (!coin) {
    warnings.push('coin_missing');
  } else {
    if (coin.status !== 'complete') warnings.push('coin_not_complete');
    if (isStale(coin.lastUpdated, windows.coin, now)) warnings.push('coin_stale');
  }

  // ---- Pool ----
  const pool = await loadBestPool(resolvedDb, position.mint);
  if (!pool) {
    warnings.push('pool_missing');
  } else if (isStale(pool.lastUpdated, windows.pool, now)) {
    warnings.push('pool_stale');
  }

  // ---- Events ----
  const events = await loadLatestEventsByInterval(resolvedDb, position.mint, intervals);
  for (const interval of intervals) {
    const row = events[interval];
    if (!row) {
      warnings.push(`events_missing:${interval}`);
      continue;
    }
    if (isStale(row.updatedAt, windows.events, now)) {
      warnings.push(`events_stale:${interval}`);
    }
  }

  // ---- Risk ----
  const risk = await loadRisk(resolvedDb, position.mint);
  if (!risk) {
    warnings.push('risk_missing');
  } else {
    if (isStale(risk.updatedAt, windows.risk, now)) warnings.push('risk_stale');

    // Parse risksJson once for downstream consumers (strategies/autopsy/HUD).
    // Store on a new non-breaking field `risk.risks` (array) when possible.
    if (risk.risks == null && risk.risksJson != null) {
      try {
        const parsed = typeof risk.risksJson === 'string' ? JSON.parse(risk.risksJson) : risk.risksJson;
        if (Array.isArray(parsed)) risk.risks = parsed;
      } catch (e) {
        warnings.push('risk_risks_json_parse_failed');
      }
    }
  }

  // ---- PnL (live view) ----
  const pnl = await loadPnlPositionLive(resolvedDb, {
    walletId: position.walletId,
    coinMint: position.mint,
    tradeUuid: position.tradeUuid,
  });
  if (!pnl) warnings.push('pnl_missing');

  // ---- Derived ----
  let derived = {};
  try {
    derived = computeDerived({ position, coin, pool, pnl });
  } catch (err) {
    warnings.push('derived_failed');
  }

  // ---- OHLCV + indicators (optional) ----
  let chart = null;
  let ta = null;

  try {
    const hasDataClient = !!dataClient;
    const poolAddress = pool?.id || null;

    if (hasDataClient && poolAddress) {
      const o = { ...DEFAULT_OHLCV, ...(ohlcv || {}) };
      const ind = { ...DEFAULT_INDICATORS, ...(indicators || {}) };

      const timeTo = Math.floor(now / 1000);
      const timeFrom = Math.floor((now - Number(o.lookbackMs || DEFAULT_OHLCV.lookbackMs)) / 1000);

      const raw = await fetchTokenPoolOhlcv({
        dataClient,
        mint: position.mint,
        poolAddress,
        type: o.type,
        timeFrom,
        timeTo,
        fastCache: o.fastCache,
        removeOutliers: o.removeOutliers,
        timezone: o.timezone,
        marketCap: o.marketCap,
      });

      const candles = normalizeOhlcvResponse(raw);
      const closes = candles.map((c) => c.c);

      chart = {
        type: o.type,
        lookbackMs: Number(o.lookbackMs || DEFAULT_OHLCV.lookbackMs),
        poolAddress,
        points: candles.length,
        timeFrom,
        timeTo,
        candles: includeCandles ? candles : undefined,
      };

      const emaFast = computeEmaSeries(closes, ind.emaFast);
      const emaSlow = computeEmaSeries(closes, ind.emaSlow);
      const macd = computeMacd(closes, ind.emaFast, ind.emaSlow, ind.macdSignal);
      const vwapRes = computeVwap(candles, ind.vwapPeriods);

      ta = {
        rsi: computeRsi(closes, ind.rsiPeriod),
        atr: computeAtr(candles, ind.atrPeriod),
        slopePctPerCandle: computeSlopePct(closes, ind.slopePeriods),

        emaFast,
        emaSlow,
        macd,

        vwap: vwapRes.vwap,
        vwapVolume: vwapRes.volume,

        lastClose: closes.length ? closes[closes.length - 1] : null,
      };

      // Strategy-friendly derived metric: ATR as a percentage of price.
      // Many sizing/stop models use ATR% rather than absolute ATR units.
      if (derived && ta && ta.atr != null && ta.lastClose != null) {
        const atr = Number(ta.atr);
        const lastClose = Number(ta.lastClose);
        if (Number.isFinite(atr) && Number.isFinite(lastClose) && lastClose > 0) {
          derived.atrPct = (atr / lastClose) * 100;
        }
      }

      if (candles.length === 0) warnings.push('ohlcv_empty');
      if (vwapRes.volume === 0) warnings.push('ohlcv_zero_volume');
    } else {
      if (!hasDataClient) warnings.push('ohlcv_no_client');
      if (!poolAddress) warnings.push('ohlcv_no_pool');
    }
  } catch (err) {
    warnings.push('ohlcv_failed');
  }

  const evaluation = {
    walletAlias: position.walletAlias,
    walletId: position.walletId,
    mint: position.mint,
    tradeUuid: position.tradeUuid,
    createdAt: now,
    position,
    coin,
    pool,
    events,
    risk,
    pnl,
    derived,
    chart,
    indicators: ta,
    warnings,
  };

  return { evaluation, warnings };
}

module.exports = {
  buildEvaluation,

  // Export loaders for unit tests / advanced callers
  _internal: {
    normalizeRows,
    dbQuery,
    isStale,
    loadCoin,
    loadBestPool,
    loadLatestEventsByInterval,
    loadRisk,
    loadPnlPositionLive,
    computeDerived,
    normalizeOhlcvResponse,
    computeRsi,
    computeAtr,
    computeSlopePct,
    fetchTokenPoolOhlcv,
    computeEmaSeries,
    computeEmaSeriesAll,
    computeMacd,
    computeVwap,
  },
};
