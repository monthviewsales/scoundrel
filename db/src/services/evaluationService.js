'use strict';

const { db: contextDb } = require('../adapters/sqlite');

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

function computeRsi(closes, period) {
  const p = Math.max(1, Number(period || 14));
  if (!Array.isArray(closes) || closes.length < p + 1) return null;

  let gains = 0;
  let losses = 0;

  // seed with first p deltas
  for (let i = 1; i <= p; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }

  let avgGain = gains / p;
  let avgLoss = losses / p;

  // Wilder smoothing over remaining points
  for (let i = p + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;

    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number.isFinite(rsi) ? rsi : null;
}

function computeAtr(candles, period) {
  const p = Math.max(1, Number(period || 14));
  if (!Array.isArray(candles) || candles.length < p + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    trs.push(tr);
  }

  if (trs.length < p) return null;

  // Wilder ATR smoothing
  let atr = 0;
  for (let i = 0; i < p; i++) atr += trs[i];
  atr /= p;

  for (let i = p; i < trs.length; i++) {
    atr = (atr * (p - 1) + trs[i]) / p;
  }

  return Number.isFinite(atr) ? atr : null;
}

function computeSlopePct(closes, periods) {
  const n = Math.max(2, Number(periods || 30));
  if (!Array.isArray(closes) || closes.length < n) return null;

  const slice = closes.slice(-n);
  const xs = [];
  const ys = slice;
  for (let i = 0; i < slice.length; i++) xs.push(i);

  const meanX = (xs.reduce((a, b) => a + b, 0)) / xs.length;
  const meanY = (ys.reduce((a, b) => a + b, 0)) / ys.length;

  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }

  if (!den) return null;
  const slope = num / den; // price units per candle

  const base = ys[0] || 0;
  if (!base) return null;

  // Convert to % change per candle relative to starting price.
  const slopePct = (slope / base) * 100;
  return Number.isFinite(slopePct) ? slopePct : null;
}

function computeEmaSeries(values, period) {
  const p = Math.max(1, Number(period || 12));
  if (!Array.isArray(values) || values.length < p) return null;

  // Seed EMA with SMA of first p values
  let sma = 0;
  for (let i = 0; i < p; i++) sma += values[i];
  sma /= p;

  const k = 2 / (p + 1);
  let ema = sma;

  for (let i = p; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return Number.isFinite(ema) ? ema : null;
}

function computeEmaSeriesAll(values, period) {
  const p = Math.max(1, Number(period || 12));
  if (!Array.isArray(values) || values.length < p) return null;

  // Seed EMA with SMA of first p values
  let sma = 0;
  for (let i = 0; i < p; i++) sma += values[i];
  sma /= p;

  const k = 2 / (p + 1);
  let ema = sma;
  const out = [];

  // Output aligned to input indices: null until we have a seed.
  for (let i = 0; i < p - 1; i++) out.push(null);
  out.push(ema);

  for (let i = p; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }

  return out;
}

function computeMacd(closes, fastPeriod, slowPeriod, signalPeriod) {
  const fast = Math.max(1, Number(fastPeriod || 12));
  const slow = Math.max(1, Number(slowPeriod || 26));
  const signal = Math.max(1, Number(signalPeriod || 9));

  if (!Array.isArray(closes) || closes.length < slow + signal) return null;

  const emaFastAll = computeEmaSeriesAll(closes, fast);
  const emaSlowAll = computeEmaSeriesAll(closes, slow);
  if (!emaFastAll || !emaSlowAll) return null;

  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFastAll[i];
    const s = emaSlowAll[i];
    macdLine.push(f != null && s != null ? (f - s) : null);
  }

  // Build signal EMA over macdLine where defined
  const macdDefined = macdLine.filter((v) => v != null);
  if (macdDefined.length < signal) return null;

  // Compute signal EMA across defined macd points (latest value)
  const signalValue = computeEmaSeries(macdDefined, signal);
  const lastMacd = macdDefined[macdDefined.length - 1];

  if (signalValue == null || lastMacd == null) return null;

  const hist = lastMacd - signalValue;

  return {
    macd: Number.isFinite(lastMacd) ? lastMacd : null,
    signal: Number.isFinite(signalValue) ? signalValue : null,
    hist: Number.isFinite(hist) ? hist : null,
  };
}

function computeVwap(candles, periods) {
  if (!Array.isArray(candles) || candles.length === 0) return { vwap: null, volume: null };

  const n = periods == null ? candles.length : Math.max(1, Number(periods));
  const slice = candles.slice(-n);

  let pv = 0;
  let vSum = 0;

  for (const c of slice) {
    const v = Number.isFinite(Number(c.v)) ? Number(c.v) : 0;
    const tp = (Number(c.h) + Number(c.l) + Number(c.c)) / 3;
    if (!Number.isFinite(tp)) continue;
    pv += tp * v;
    vSum += v;
  }

  if (!vSum) return { vwap: null, volume: 0 };

  const vwap = pv / vSum;
  return {
    vwap: Number.isFinite(vwap) ? vwap : null,
    volume: vSum,
  };
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
  } else if (isStale(risk.updatedAt, windows.risk, now)) {
    warnings.push('risk_stale');
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

      const timeTo = now;
      const timeFrom = timeTo - Number(o.lookbackMs || DEFAULT_OHLCV.lookbackMs);

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