"use strict";

const { db, logger } = require("./context");

/**
 * Best-effort conversion to number.
 * Returns null for undefined/null/empty string/NaN.
 *
 * @param {any} v
 * @returns {number|null}
 */
function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
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
    if (v === undefined) return "null";
    return JSON.stringify(v);
  } catch (err) {
    return JSON.stringify({
      error: "json_stringify_failed",
      message: String(err && err.message ? err.message : err),
    });
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
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Map a DB row into a consistent evaluation shape for callers.
 *
 * @param {Object} row
 * @returns {Object|null}
 */
function mapEvaluationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    opsType: row.opsType,
    tsMs: row.tsMs,
    walletId: row.walletId,
    walletAlias: row.walletAlias,
    tradeUuid: row.tradeUuid,
    coinMint: row.coinMint,
    symbol: row.symbol,

    targetStatus: row.targetStatus,
    targetScore: row.targetScore,
    targetConfidence: row.targetConfidence,

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
 * Insert a unified evaluation snapshot into sc_evaluations.
 *
 * @param {Object} record
 * @param {string} record.opsType
 * @param {number} record.walletId
 * @param {string} record.walletAlias
 * @param {string} record.coinMint
 * @param {string} [record.tradeUuid]
 * @param {string} [record.symbol]
 * @param {number} [record.tsMs]
 *
 * @param {string} [record.targetStatus]
 * @param {number} [record.targetScore]
 * @param {number} [record.targetConfidence]
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
 * @param {any} [record.reasons]
 * @param {any} [record.payload]
 *
 * @returns {number} inserted row id
 */
function insertEvaluation(record) {
  if (
    !record ||
    !record.opsType ||
    !record.walletId ||
    !record.walletAlias ||
    !record.coinMint
  ) {
    throw new Error(
      "insertEvaluation: opsType, walletId, walletAlias, and coinMint are required."
    );
  }
  if (!record.recommendation || !record.decision) {
    throw new Error(
      "insertEvaluation: recommendation and decision are required."
    );
  }

  const now = Date.now();
  const tsMs = toNum(record.tsMs) ?? now;

  const stmt = db.prepare(
    `INSERT INTO sc_evaluations (
       ops_type,
       ts_ms,
       wallet_id,
       wallet_alias,
       trade_uuid,
       coin_mint,
       symbol,

       target_status,
       target_score,
       target_confidence,

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
       @ops_type,
       @ts_ms,
       @wallet_id,
       @wallet_alias,
       @trade_uuid,
       @coin_mint,
       @symbol,

       @target_status,
       @target_score,
       @target_confidence,

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
    ops_type: toStr(record.opsType, 16),
    ts_ms: tsMs,
    wallet_id: toNum(record.walletId),
    wallet_alias: toStr(record.walletAlias, 64),
    trade_uuid: toStr(record.tradeUuid, 36),
    coin_mint: toStr(record.coinMint, 64),
    symbol: toStr(record.symbol, 32),

    target_status: toStr(record.targetStatus, 16),
    target_score: toNum(record.targetScore),
    target_confidence: toNum(record.targetConfidence),

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

  const id =
    res && (res.lastInsertRowid || res.lastInsertRowid === 0)
      ? Number(res.lastInsertRowid)
      : null;

  if (logger && typeof logger.debug === "function") {
    logger.debug(
      `[BootyBox][evaluations] inserted evaluation tick id=${id} ops=${record.opsType} mint=${record.coinMint}`
    );
  }

  return id;
}

/**
 * Fetch the most recent evaluation tick for a trade.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @param {string} [opsType]
 * @returns {Object|null}
 */
function getLatestEvaluationByTrade(walletId, tradeUuid, opsType) {
  if (!walletId || !tradeUuid) return null;
  let sql = `
    SELECT
      id,
      ops_type         AS opsType,
      ts_ms            AS tsMs,
      wallet_id        AS walletId,
      wallet_alias     AS walletAlias,
      trade_uuid       AS tradeUuid,
      coin_mint        AS coinMint,
      symbol,

      target_status    AS targetStatus,
      target_score     AS targetScore,
      target_confidence AS targetConfidence,

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
    FROM sc_evaluations
    WHERE wallet_id = ?
      AND trade_uuid = ?
  `;
  const params = [walletId, tradeUuid];
  if (opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opsType));
  }
  sql += " ORDER BY ts_ms DESC LIMIT 1";

  const row = db.prepare(sql).get(...params);
  return row ? mapEvaluationRow(row) : null;
}

/**
 * Fetch the most recent evaluation tick for a mint.
 *
 * @param {string} coinMint
 * @param {string} [opsType]
 * @returns {Object|null}
 */
function getLatestEvaluationByMint(coinMint, opsType) {
  if (!coinMint) return null;
  let sql = `
    SELECT
      id,
      ops_type         AS opsType,
      ts_ms            AS tsMs,
      wallet_id        AS walletId,
      wallet_alias     AS walletAlias,
      trade_uuid       AS tradeUuid,
      coin_mint        AS coinMint,
      symbol,

      target_status    AS targetStatus,
      target_score     AS targetScore,
      target_confidence AS targetConfidence,

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
    FROM sc_evaluations
    WHERE coin_mint = ?
  `;
  const params = [coinMint];
  if (opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opsType));
  }
  sql += " ORDER BY ts_ms DESC LIMIT 1";

  const row = db.prepare(sql).get(...params);
  return row ? mapEvaluationRow(row) : null;
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
 * @param {string} [opts.opsType]
 * @returns {Object[]}
 */
function listEvaluationsByTrade(walletId, tradeUuid, opts = {}) {
  if (!walletId || !tradeUuid) return [];
  const limit = Math.max(1, Math.min(5000, Number(opts.limit ?? 500)));

  let sql = `
    SELECT
      id,
      ops_type         AS opsType,
      ts_ms            AS tsMs,
      wallet_id        AS walletId,
      wallet_alias     AS walletAlias,
      trade_uuid       AS tradeUuid,
      coin_mint        AS coinMint,
      symbol,

      target_status    AS targetStatus,
      target_score     AS targetScore,
      target_confidence AS targetConfidence,

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
    FROM sc_evaluations
    WHERE wallet_id = ?
      AND trade_uuid = ?
  `;
  const params = [walletId, tradeUuid];

  if (opts.opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opts.opsType));
  }

  if (opts.startTsMs != null) {
    sql += " AND ts_ms >= ?";
    params.push(Number(opts.startTsMs));
  }

  if (opts.endTsMs != null) {
    sql += " AND ts_ms <= ?";
    params.push(Number(opts.endTsMs));
  }

  sql += " ORDER BY ts_ms ASC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return (rows || []).map(mapEvaluationRow);
}

/**
 * List evaluations for a mint (latest first).
 *
 * @param {string} coinMint
 * @param {Object} [opts]
 * @param {number} [opts.limit=25]
 * @param {string} [opts.opsType]
 * @returns {Object[]}
 */
function listEvaluationsByMint(coinMint, opts = {}) {
  if (!coinMint) return [];
  const limit = Math.max(1, Math.min(5000, Number(opts.limit ?? 25)));

  let sql = `
    SELECT
      id,
      ops_type         AS opsType,
      ts_ms            AS tsMs,
      wallet_id        AS walletId,
      wallet_alias     AS walletAlias,
      trade_uuid       AS tradeUuid,
      coin_mint        AS coinMint,
      symbol,

      target_status    AS targetStatus,
      target_score     AS targetScore,
      target_confidence AS targetConfidence,

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
    FROM sc_evaluations
    WHERE coin_mint = ?
  `;
  const params = [coinMint];

  if (opts.opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opts.opsType));
  }

  sql += " ORDER BY ts_ms DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return (rows || []).map(mapEvaluationRow);
}

/**
 * List recent evaluation ticks for a wallet.
 *
 * @param {number} walletId
 * @param {Object} [opts]
 * @param {number} [opts.limit=200]
 * @param {string} [opts.opsType]
 * @returns {Object[]}
 */
function listRecentEvaluations(walletId, opts = {}) {
  if (!walletId) return [];
  const limit = Math.max(1, Math.min(5000, Number(opts.limit ?? 200)));

  let sql = `
    SELECT
      id,
      ops_type         AS opsType,
      ts_ms            AS tsMs,
      wallet_id        AS walletId,
      wallet_alias     AS walletAlias,
      trade_uuid       AS tradeUuid,
      coin_mint        AS coinMint,
      symbol,

      target_status    AS targetStatus,
      target_score     AS targetScore,
      target_confidence AS targetConfidence,

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
    FROM sc_evaluations
    WHERE wallet_id = ?
  `;
  const params = [walletId];

  if (opts.opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opts.opsType));
  }

  sql += " ORDER BY ts_ms DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return (rows || []).map(mapEvaluationRow);
}

/**
 * Hard delete evaluations for a single trade (useful when cleaning up test data).
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @param {string} [opsType]
 * @returns {number} number of deleted rows
 */
function deleteEvaluationsByTrade(walletId, tradeUuid, opsType) {
  if (!walletId || !tradeUuid) return 0;
  let sql = "DELETE FROM sc_evaluations WHERE wallet_id = ? AND trade_uuid = ?";
  const params = [walletId, tradeUuid];
  if (opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opsType));
  }
  const res = db.prepare(sql).run(...params);
  return res && res.changes ? res.changes : 0;
}

/**
 * Prune old evaluation rows (optional maintenance).
 *
 * @param {Object} opts
 * @param {number} opts.olderThanTsMs - delete where ts_ms < this
 * @param {string} [opts.opsType]
 * @returns {number} number of deleted rows
 */
function pruneEvaluations(opts = {}) {
  const olderThanTsMs = toNum(opts.olderThanTsMs);
  if (!olderThanTsMs) return 0;
  let sql = "DELETE FROM sc_evaluations WHERE ts_ms < ?";
  const params = [olderThanTsMs];
  if (opts.opsType) {
    sql += " AND ops_type = ?";
    params.push(String(opts.opsType));
  }
  const res = db.prepare(sql).run(...params);
  return res && res.changes ? res.changes : 0;
}

module.exports = {
  mapEvaluationRow,
  insertEvaluation,
  getLatestEvaluationByTrade,
  getLatestEvaluationByMint,
  listEvaluationsByTrade,
  listEvaluationsByMint,
  listRecentEvaluations,
  deleteEvaluationsByTrade,
  pruneEvaluations,
};
