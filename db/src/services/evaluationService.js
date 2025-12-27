

'use strict';

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
  if (!db) throw new Error('evaluationService requires a db handle');

  if (typeof db.query === 'function') {
    return db.query(sql, params);
  }
  if (typeof db.execute === 'function') {
    return db.execute(sql, params);
  }

  throw new Error('db handle does not support query() or execute()');
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
// Public API
// --------------------------

/**
 * Build a complete evaluation snapshot for a trade/position.
 *
 * @param {Object} args
 * @param {*} args.db - DB handle with query() or execute()
 * @param {Object} args.position - Position summary (schema-aware)
 * @param {number} [args.nowMs] - Override current time (ms)
 * @param {string[]} [args.eventIntervals] - intervals to load (default 5m/15m/1h)
 * @param {Object} [args.freshness] - overrides for freshness windows (ms)
 * @returns {Promise<{evaluation: Object, warnings: string[]}>}
 */
async function buildEvaluation({
  db,
  position,
  nowMs,
  eventIntervals,
  freshness,
}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const windows = { ...DEFAULT_FRESHNESS, ...(freshness || {}) };
  const intervals = Array.isArray(eventIntervals) && eventIntervals.length
    ? eventIntervals
    : DEFAULT_EVENT_INTERVALS;

  const warnings = [];

  // ---- Coin ----
  const coin = await loadCoin(db, position.mint);
  if (!coin) {
    warnings.push('coin_missing');
  } else {
    if (coin.status !== 'complete') warnings.push('coin_not_complete');
    if (isStale(coin.lastUpdated, windows.coin, now)) warnings.push('coin_stale');
  }

  // ---- Pool ----
  const pool = await loadBestPool(db, position.mint);
  if (!pool) {
    warnings.push('pool_missing');
  } else if (isStale(pool.lastUpdated, windows.pool, now)) {
    warnings.push('pool_stale');
  }

  // ---- Events ----
  const events = await loadLatestEventsByInterval(db, position.mint, intervals);
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
  const risk = await loadRisk(db, position.mint);
  if (!risk) {
    warnings.push('risk_missing');
  } else if (isStale(risk.updatedAt, windows.risk, now)) {
    warnings.push('risk_stale');
  }

  // ---- PnL (live view) ----
  const pnl = await loadPnlPositionLive(db, {
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
  },
};