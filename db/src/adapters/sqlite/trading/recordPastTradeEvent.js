'use strict';

const getPastSessionId = require('../session/getPastSessionId');
const { db, logger } = require('../context');

let ensuredTxidIndex = false;

function ensureTxidIndex() {
  if (ensuredTxidIndex) return;
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_trades_txid ON sc_trades(txid)');
    ensuredTxidIndex = true;
  } catch (err) {
    logger?.warn?.(`[BootyBox] ensureTxidIndex failed: ${err?.message || err}`);
  }
}

/**
 * Record a *past* (historical) trade into sc_trades.
 *
 * This is intentionally minimal and side-effect free:
 * - UPSERT by txid (txid is UNIQUE)
 * - Does NOT touch sc_positions
 * - Does NOT attempt to resolve/create trade_uuid
 *
 * Intended for backfilling missing txids discovered during autopsy.
 *
 * Minimal expected fields:
 * - wallet_id (required)
 * - coin_mint (required)
 * - side (required: 'buy' | 'sell')
 * - txid (required)
 * - executed_at (optional; seconds or ms epoch)
 * - token_amount (optional)
 * - sol_amount (optional)
 * - price_usd_per_token (optional)
 *
 * Optional tagging fields (for tracking provenance):
 * - source (string)
 * - note (string)
 *
 * @param {Object} trade
 * @returns {Object} The inserted/updated trade row (best-effort).
 */
function recordPastTradeEvent(trade) {
  if (!trade || typeof trade !== 'object') {
    throw new TypeError('recordPastTradeEvent(trade) requires a trade object');
  }

  const now = Date.now();

  if (process.env.SC_SQLITE_DIAGNOSTICS === '1') {
    logger?.debug?.(`[BootyBox][recordPastTradeEvent] file=${__filename}`);
    try {
      const dbList = db.pragma('database_list');
      logger?.debug?.(`[BootyBox][recordPastTradeEvent] database_list=${JSON.stringify(dbList)}`);
    } catch (e) {
      logger?.debug?.(`[BootyBox][recordPastTradeEvent] database_list failed: ${e?.message || e}`);
    }

    try {
      const idxList = db.pragma("index_list('sc_trades')");
      logger?.debug?.(`[BootyBox][recordPastTradeEvent] sc_trades index_list=${JSON.stringify(idxList)}`);
    } catch (e) {
      logger?.debug?.(`[BootyBox][recordPastTradeEvent] sc_trades index_list failed: ${e?.message || e}`);
    }
  }

  // Required fields
  const walletId = trade.wallet_id ?? trade.walletId;
  const walletAlias = trade.wallet_alias ?? trade.walletAlias ?? null;
  const coinMint = trade.coin_mint ?? trade.coinMint;
  const side = trade.side;
  const txid = trade.txid ?? trade.tx ?? null;

  if (!walletId || !coinMint || !side || !txid) {
    throw new Error(
      `recordPastTradeEvent missing required fields: wallet_id=${walletId}, coin_mint=${coinMint}, side=${side}, txid=${txid}`
    );
  }

  // Normalize executed_at: accept seconds or ms epoch; default to now.
  const executedAtCandidate = trade.executed_at ?? trade.executedAt ?? trade.time;
  let executedAt = Number.isFinite(Number(executedAtCandidate)) && Number(executedAtCandidate) > 0
    ? Number(executedAtCandidate)
    : now;
  // Heuristic: if it's seconds epoch (10 digits-ish), convert to ms.
  if (executedAt > 0 && executedAt < 100000000000) {
    executedAt = executedAt * 1000;
  }

  // Minimal numeric fields (allow null)
  const tokenAmount = trade.token_amount ?? trade.tokenAmount ?? trade.amount ?? null;
  const solAmount = trade.sol_amount ?? trade.solAmount ?? trade.volumeSol ?? null;
  const priceUsdPerToken = trade.price_usd_per_token ?? trade.priceUsdPerToken ?? trade.priceUsd ?? null;

  // Optional tracking / provenance
  const source = trade.source ?? null;
  const note = trade.note ?? null;

  // Optional session id (best-effort)
  let sessionId = trade.session_id ?? trade.sessionId ?? null;
  if (!sessionId) {
    sessionId = getPastSessionId({
      service: 'warchest-service',
      timestamp: executedAt,
    });
  }

  if (sessionId == null) {
    sessionId = 'unknown';
  }

  // Optional trade_uuid: only use if caller provides it; do not resolve/create.
  const tradeUuid = trade.trade_uuid ?? trade.tradeUuid ?? null;

  // Insert trade
  // If txid is present, UPSERT by txid and preserve existing non-null fields when duplicates omit them.
  ensureTxidIndex();
  const stmtUpsertByTxid = db.prepare(
    `
    INSERT INTO sc_trades (
      wallet_id,
      wallet_alias,
      session_id,
      trade_uuid,
      coin_mint,
      txid,
      side,
      executed_at,
      token_amount,
      sol_amount,
      price_usd_per_token,
      decision_label,
      decision_reason,
      created_at,
      updated_at
    ) VALUES (
      @wallet_id,
      @wallet_alias,
      @session_id,
      @trade_uuid,
      @coin_mint,
      @txid,
      @side,
      @executed_at,
      @token_amount,
      @sol_amount,
      @price_usd_per_token,
      @decision_label,
      @decision_reason,
      @created_at,
      @updated_at
    )
    ON CONFLICT(txid) DO UPDATE SET
      wallet_id = COALESCE(excluded.wallet_id, sc_trades.wallet_id),
      wallet_alias = COALESCE(excluded.wallet_alias, sc_trades.wallet_alias),
      session_id = COALESCE(excluded.session_id, sc_trades.session_id),
      trade_uuid = COALESCE(excluded.trade_uuid, sc_trades.trade_uuid),
      coin_mint = COALESCE(excluded.coin_mint, sc_trades.coin_mint),
      side = COALESCE(excluded.side, sc_trades.side),
      executed_at = MAX(sc_trades.executed_at, excluded.executed_at),
      token_amount = COALESCE(excluded.token_amount, sc_trades.token_amount),
      sol_amount = COALESCE(excluded.sol_amount, sc_trades.sol_amount),
      price_usd_per_token = COALESCE(excluded.price_usd_per_token, sc_trades.price_usd_per_token),
      decision_label = COALESCE(excluded.decision_label, sc_trades.decision_label),
      decision_reason = COALESCE(excluded.decision_reason, sc_trades.decision_reason),
      updated_at = excluded.updated_at
    `
  );

  if (process.env.SC_SQLITE_DIAGNOSTICS === '1') {
    try {
      // better-sqlite3 exposes the SQL text via `statement.source`.
      logger?.debug?.(`[BootyBox][recordPastTradeEvent] upsert SQL: ${stmtUpsertByTxid.source}`);
    } catch (e) {
      logger?.debug?.(`[BootyBox][recordPastTradeEvent] unable to read statement.source: ${e?.message || e}`);
    }
  }

  const params = {
    wallet_id: walletId,
    wallet_alias: walletAlias,
    session_id: sessionId,
    trade_uuid: tradeUuid,
    coin_mint: coinMint,
    txid,
    side,
    executed_at: executedAt,
    token_amount: tokenAmount,
    sol_amount: solAmount,
    price_usd_per_token: priceUsdPerToken,
    // Track provenance using existing decision_* columns (no schema change needed)
    decision_label: source ? String(source).slice(0, 255) : 'past_trade_backfill',
    decision_reason: note ? String(note).slice(0, 1024) : null,
    created_at: now,
    updated_at: now,
  };

  let info;
  try {
    info = stmtUpsertByTxid.run(params);
  } catch (err) {
    // If the DB file was created before UNIQUE(txid) existed, attempt to fix and retry once.
    if (String(err?.message || '').includes('ON CONFLICT clause does not match')) {
      logger?.warn?.(
        `[BootyBox] sc_trades upsert failed (missing UNIQUE(txid)?). Attempting to create index and retry: ${err?.message || err}`
      );
      ensureTxidIndex();
      try {
        info = stmtUpsertByTxid.run(params);
      } catch (retryErr) {
        logger?.warn?.(
          `[BootyBox] sc_trades upsert retry failed: ${retryErr?.message || retryErr}`
        );
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  // Return best-effort inserted/updated trade row
  const row = db.prepare('SELECT * FROM sc_trades WHERE txid = ?').get(txid);

  return row || { id: info.lastInsertRowid, ...params };
}

module.exports = recordPastTradeEvent;
