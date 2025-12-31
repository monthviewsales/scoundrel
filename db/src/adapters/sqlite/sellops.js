

'use strict';

const { db, logger } = require('./context');

/**
 * Best-effort conversion to number.
 * Returns null for undefined/null/empty string/NaN.
 *
 * @param {any} v
 * @returns {number|null}
 */
function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a string for storage (trim + max length).
 *
 * @param {any} v
 * @param {number} max
 * @returns {string|null}
 */
function toStr(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!max || s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * Safely JSON stringify for DB storage.
 *
 * @param {any} v
 * @returns {string}
 */
function toJson(v) {
  try {
    if (v === undefined) return 'null';
    return JSON.stringify(v);
  } catch (err) {
    // Never let stringify kill SellOps. Store a minimal fallback.
    return JSON.stringify({ error: 'json_stringify_failed', message: String(err && err.message ? err.message : err) });
  }
}

/**
 * Parse JSON, returning null on failure.
 *
 * @param {any} v
 * @returns {any|null}
 */
function fromJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Map a DB row into a consistent shape for callers.
 *
 * @param {Object} row
 * @returns {Object|null}
 */
function mapSellOpsEvaluationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tsMs: row.tsMs,
    walletId: row.walletId,
    walletAlias: row.walletAlias,
    tradeUuid: row.tradeUuid,
    coinMint: row.coinMint,
    symbol: row.symbol,

    strategyName: row.strategyName,
    strategySource: row.strategySource,
    recommendation: row.recommendation,
    decision: row.decision,
    regime: row.regime,

    qualifyFailedCount: row.qualifyFailedCount,
    qualifyWorstSeverity: row.qualifyWorstSeverity,
    gateFail: row.gateFail,

    priceUsd: row.priceUsd,
    liquidityUsd: row.liquidityUsd,
    chartInterval: row.chartInterval,
    chartPoints: row.chartPoints,

    rsi: row.rsi,
    macdHist: row.macdHist,
    vwap: row.vwap,
    warningsCount: row.warningsCount,

    unrealUsd: row.unrealUsd,
    totalUsd: row.totalUsd,
    roiPct: row.roiPct,

    reasons: fromJson(row.reasonsJson),
    payload: fromJson(row.payloadJson),

    insertedAt: row.insertedAt,
  };
}

/**
 * Insert a SellOps evaluation tick snapshot into sc_sellops_evaluations.
 * This is designed to be called every tick (e.g., every minute per open position).
 *
 * NOTE: For forward compatibility, we store both `reasons_json` and `payload_json` verbatim.
 *
 * @param {Object} record
 * @param {number} record.walletId
 * @param {string} record.walletAlias
 * @param {string} record.tradeUuid
 * @param {string} record.coinMint
 * @param {string} [record.symbol]
 * @param {number} [record.tsMs] - defaults to Date.now()
 *
 * @param {string} [record.strategyName]
 * @param {string} [record.strategySource]
 * @param {string} record.recommendation
 * @param {string} record.decision
 * @param {string} [record.regime]
 *
 * @param {number} [record.qualifyFailedCount]
 * @param {string} [record.qualifyWorstSeverity]
 * @param {string} [record.gateFail]
 *
 * @param {number} [record.priceUsd]
 * @param {number} [record.liquidityUsd]
 * @param {string} [record.chartInterval]
 * @param {number} [record.chartPoints]
 *
 * @param {number} [record.rsi]
 * @param {number} [record.macdHist]
 * @param {number} [record.vwap]
 * @param {number} [record.warningsCount]
 *
 * @param {number} [record.unrealUsd]
 * @param {number} [record.totalUsd]
 * @param {number} [record.roiPct]
 *
 * @param {any} [record.reasons] - array or string; stored as JSON
 * @param {any} [record.payload] - full evaluation payload; stored as JSON
 *
 * @returns {number} inserted row id
 */
function insertSellOpsEvaluation(record) {
  if (!record || !record.walletId || !record.walletAlias || !record.tradeUuid || !record.coinMint) {
    throw new Error('insertSellOpsEvaluation: walletId, walletAlias, tradeUuid, and coinMint are required.');
  }
  if (!record.recommendation || !record.decision) {
    throw new Error('insertSellOpsEvaluation: recommendation and decision are required.');
  }

  const now = Date.now();
  const tsMs = toNum(record.tsMs) ?? now;

  const stmt = db.prepare(
    `INSERT INTO sc_sellops_evaluations (
       ts_ms,
       wallet_id,
       wallet_alias,
       trade_uuid,
       coin_mint,
       symbol,

       strategy_name,
       strategy_source,
       recommendation,
       decision,
       regime,

       qualify_failed_count,
       qualify_worst_severity,
       gate_fail,

       price_usd,
       liquidity_usd,
       chart_interval,
       chart_points,

       rsi,
       macd_hist,
       vwap,
       warnings_count,

       unreal_usd,
       total_usd,
       roi_pct,

       reasons_json,
       payload_json,

       inserted_at
     ) VALUES (
       @ts_ms,
       @wallet_id,
       @wallet_alias,
       @trade_uuid,
       @coin_mint,
       @symbol,

       @strategy_name,
       @strategy_source,
       @recommendation,
       @decision,
       @regime,

       @qualify_failed_count,
       @qualify_worst_severity,
       @gate_fail,

       @price_usd,
       @liquidity_usd,
       @chart_interval,
       @chart_points,

       @rsi,
       @macd_hist,
       @vwap,
       @warnings_count,

       @unreal_usd,
       @total_usd,
       @roi_pct,

       @reasons_json,
       @payload_json,

       @inserted_at
     )`
  );

  const res = stmt.run({
    ts_ms: tsMs,
    wallet_id: toNum(record.walletId),
    wallet_alias: toStr(record.walletAlias, 64),
    trade_uuid: toStr(record.tradeUuid, 36),
    coin_mint: toStr(record.coinMint, 64),
    symbol: toStr(record.symbol, 32),

    strategy_name: toStr(record.strategyName, 32),
    strategy_source: toStr(record.strategySource, 32),
    recommendation: toStr(record.recommendation, 16),
    decision: toStr(record.decision, 16),
    regime: toStr(record.regime, 16),

    qualify_failed_count: toNum(record.qualifyFailedCount) ?? 0,
    qualify_worst_severity: toStr(record.qualifyWorstSeverity, 16),
    gate_fail: toStr(record.gateFail, 64),

    price_usd: toNum(record.priceUsd),
    liquidity_usd: toNum(record.liquidityUsd),
    chart_interval: toStr(record.chartInterval, 8),
    chart_points: toNum(record.chartPoints),

    rsi: toNum(record.rsi),
    macd_hist: toNum(record.macdHist),
    vwap: toNum(record.vwap),
    warnings_count: toNum(record.warningsCount) ?? 0,

    unreal_usd: toNum(record.unrealUsd),
    total_usd: toNum(record.totalUsd),
    roi_pct: toNum(record.roiPct),

    reasons_json: toJson(record.reasons ?? []),
    payload_json: toJson(record.payload ?? null),

    inserted_at: now,
  });

  const id = res && (res.lastInsertRowid || res.lastInsertRowid === 0) ? Number(res.lastInsertRowid) : null;

  // Helpful debug breadcrumb (quiet by default).
  if (logger && typeof logger.debug === 'function') {
    logger.debug(`[BootyBox][sellops] inserted evaluation tick id=${id} trade_uuid=${record.tradeUuid} mint=${record.coinMint}`);
  }

  return id;
}

/**
 * Fetch the most recent evaluation tick for a trade.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @returns {Object|null}
 */
function getLatestSellOpsEvaluationByTrade(walletId, tradeUuid) {
  if (!walletId || !tradeUuid) return null;
  const row = db
    .prepare(
      `SELECT
         id,
         ts_ms            AS tsMs,
         wallet_id        AS walletId,
         wallet_alias     AS walletAlias,
         trade_uuid       AS tradeUuid,
         coin_mint        AS coinMint,
         symbol,

         strategy_name    AS strategyName,
         strategy_source  AS strategySource,
         recommendation,
         decision,
         regime,

         qualify_failed_count   AS qualifyFailedCount,
         qualify_worst_severity AS qualifyWorstSeverity,
         gate_fail              AS gateFail,

         price_usd         AS priceUsd,
         liquidity_usd     AS liquidityUsd,
         chart_interval    AS chartInterval,
         chart_points      AS chartPoints,

         rsi,
         macd_hist         AS macdHist,
         vwap,
         warnings_count    AS warningsCount,

         unreal_usd        AS unrealUsd,
         total_usd         AS totalUsd,
         roi_pct           AS roiPct,

         reasons_json      AS reasonsJson,
         payload_json      AS payloadJson,
         inserted_at       AS insertedAt
       FROM sc_sellops_evaluations
       WHERE wallet_id = ?
         AND trade_uuid = ?
       ORDER BY ts_ms DESC
       LIMIT 1`
    )
    .get(walletId, tradeUuid);

  return row ? mapSellOpsEvaluationRow(row) : null;
}

/**
 * List evaluation ticks for a trade within a time window.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @param {Object} [opts]
 * @param {number} [opts.startTsMs]
 * @param {number} [opts.endTsMs]
 * @param {number} [opts.limit=500]
 * @returns {Object[]}
 */
function listSellOpsEvaluationsByTrade(walletId, tradeUuid, opts = {}) {
  if (!walletId || !tradeUuid) return [];
  const limit = Math.max(1, Math.min(5000, Number(opts.limit ?? 500)));

  let sql = `
    SELECT
      id,
      ts_ms            AS tsMs,
      wallet_id        AS walletId,
      wallet_alias     AS walletAlias,
      trade_uuid       AS tradeUuid,
      coin_mint        AS coinMint,
      symbol,

      strategy_name    AS strategyName,
      strategy_source  AS strategySource,
      recommendation,
      decision,
      regime,

      qualify_failed_count   AS qualifyFailedCount,
      qualify_worst_severity AS qualifyWorstSeverity,
      gate_fail              AS gateFail,

      price_usd         AS priceUsd,
      liquidity_usd     AS liquidityUsd,
      chart_interval    AS chartInterval,
      chart_points      AS chartPoints,

      rsi,
      macd_hist         AS macdHist,
      vwap,
      warnings_count    AS warningsCount,

      unreal_usd        AS unrealUsd,
      total_usd         AS totalUsd,
      roi_pct           AS roiPct,

      reasons_json      AS reasonsJson,
      payload_json      AS payloadJson,
      inserted_at       AS insertedAt
    FROM sc_sellops_evaluations
    WHERE wallet_id = ?
      AND trade_uuid = ?
  `;
  const params = [walletId, tradeUuid];

  if (opts.startTsMs != null) {
    sql += ' AND ts_ms >= ?';
    params.push(Number(opts.startTsMs));
  }

  if (opts.endTsMs != null) {
    sql += ' AND ts_ms <= ?';
    params.push(Number(opts.endTsMs));
  }

  sql += ' ORDER BY ts_ms ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return (rows || []).map(mapSellOpsEvaluationRow);
}

/**
 * List recent evaluation ticks for a wallet.
 *
 * @param {number} walletId
 * @param {Object} [opts]
 * @param {number} [opts.limit=200]
 * @returns {Object[]}
 */
function listRecentSellOpsEvaluations(walletId, opts = {}) {
  if (!walletId) return [];
  const limit = Math.max(1, Math.min(5000, Number(opts.limit ?? 200)));

  const rows = db
    .prepare(
      `SELECT
         id,
         ts_ms            AS tsMs,
         wallet_id        AS walletId,
         wallet_alias     AS walletAlias,
         trade_uuid       AS tradeUuid,
         coin_mint        AS coinMint,
         symbol,

         strategy_name    AS strategyName,
         strategy_source  AS strategySource,
         recommendation,
         decision,
         regime,

         qualify_failed_count   AS qualifyFailedCount,
         qualify_worst_severity AS qualifyWorstSeverity,
         gate_fail              AS gateFail,

         price_usd         AS priceUsd,
         liquidity_usd     AS liquidityUsd,
         chart_interval    AS chartInterval,
         chart_points      AS chartPoints,

         rsi,
         macd_hist         AS macdHist,
         vwap,
         warnings_count    AS warningsCount,

         unreal_usd        AS unrealUsd,
         total_usd         AS totalUsd,
         roi_pct           AS roiPct,

         reasons_json      AS reasonsJson,
         payload_json      AS payloadJson,
         inserted_at       AS insertedAt
       FROM sc_sellops_evaluations
       WHERE wallet_id = ?
       ORDER BY ts_ms DESC
       LIMIT ?`
    )
    .all(walletId, limit);

  return (rows || []).map(mapSellOpsEvaluationRow);
}

/**
 * Hard delete evaluations for a single trade (useful when cleaning up test data).
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @returns {number} number of deleted rows
 */
function deleteSellOpsEvaluationsByTrade(walletId, tradeUuid) {
  if (!walletId || !tradeUuid) return 0;
  const res = db.prepare('DELETE FROM sc_sellops_evaluations WHERE wallet_id = ? AND trade_uuid = ?').run(walletId, tradeUuid);
  return res && res.changes ? res.changes : 0;
}

/**
 * Prune old evaluation rows (optional maintenance).
 *
 * @param {Object} opts
 * @param {number} opts.olderThanTsMs - delete where ts_ms < this
 * @returns {number} number of deleted rows
 */
function pruneSellOpsEvaluations(opts = {}) {
  const olderThanTsMs = toNum(opts.olderThanTsMs);
  if (!olderThanTsMs) return 0;
  const res = db.prepare('DELETE FROM sc_sellops_evaluations WHERE ts_ms < ?').run(olderThanTsMs);
  return res && res.changes ? res.changes : 0;
}

module.exports = {
  // mappers
  mapSellOpsEvaluationRow,

  // inserts
  insertSellOpsEvaluation,

  // reads
  getLatestSellOpsEvaluationByTrade,
  listSellOpsEvaluationsByTrade,
  listRecentSellOpsEvaluations,

  // deletes / maintenance
  deleteSellOpsEvaluationsByTrade,
  pruneSellOpsEvaluations,
};