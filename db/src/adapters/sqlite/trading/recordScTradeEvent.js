'use strict';

const crypto = require('crypto');
const getActiveSessionId = require('../session/getActiveSessionId');
const {
  db,
  logger,
  resolveTradeUuid,
  setTradeUuid,
} = require('../context');

// Apply trade events to positions using the new trading-domain applier.
const applyScTradeEventToPositions = require('./applyScTradeEventToPositions');

let ensuredTxidIndex = false;

const stmtGetOpenTradeUuid = db.prepare(
  `
  SELECT trade_uuid
  FROM sc_positions
  WHERE wallet_id = ?
    AND coin_mint = ?
    AND (closed_at IS NULL OR closed_at = 0)
  ORDER BY open_at DESC
  LIMIT 1
  `
);

function getOpenTradeUuid(walletId, coinMint) {
  try {
    const row = stmtGetOpenTradeUuid.get(walletId, coinMint);
    return row?.trade_uuid || null;
  } catch (err) {
    logger?.warn?.(
      `[BootyBox] recordScTradeEvent: failed to resolve open trade_uuid from sc_positions: ${err?.message || err}`
    );
    return null;
  }
}

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
 * Record a trade event into sc_trades and update sc_positions.
 *
 * This function is the new “single writer” entry point for sc_trades.
 *
 * Notes:
 * - If trade_uuid is not provided, we resolve it from the open sc_position for (wallet_id, mint).
 * - If none exists and side is 'buy', we create a new trade_uuid (position-run id).
 * - If none exists and side is 'sell', we still create a trade_uuid so the trade is not lost,
 *   but we log a warning because this implies an untracked position-run.
 *
 * @param {Object} trade
 * @returns {Object} The inserted trade row (best-effort) including trade_uuid.
 */
function recordScTradeEvent(trade) {
  if (!trade || typeof trade !== 'object') {
    throw new TypeError('recordScTradeEvent(trade) requires a trade object');
  }

  const now = Date.now();

  if (process.env.SC_SQLITE_DIAGNOSTICS === '1') {
    logger?.debug?.(`[BootyBox][recordScTradeEvent] file=${__filename}`);
    try {
      const dbList = db.pragma('database_list');
      logger?.debug?.(`[BootyBox][recordScTradeEvent] database_list=${JSON.stringify(dbList)}`);
    } catch (e) {
      logger?.debug?.(`[BootyBox][recordScTradeEvent] database_list failed: ${e?.message || e}`);
    }

    try {
      const idxList = db.pragma("index_list('sc_trades')");
      logger?.debug?.(`[BootyBox][recordScTradeEvent] sc_trades index_list=${JSON.stringify(idxList)}`);
    } catch (e) {
      logger?.debug?.(`[BootyBox][recordScTradeEvent] sc_trades index_list failed: ${e?.message || e}`);
    }
  }

  // Required-ish fields
  const walletId = trade.wallet_id ?? trade.walletId;
  const walletAlias = trade.wallet_alias ?? trade.walletAlias ?? null;
  const coinMint = trade.coin_mint ?? trade.coinMint;
  const side = trade.side;

  if (!walletId || !coinMint || !side) {
    throw new Error(
      `recordScTradeEvent missing required fields: wallet_id=${walletId}, coin_mint=${coinMint}, side=${side}`
    );
  }

  // Normalize numerics (allow null)
  const executedAtCandidate = trade.executed_at ?? trade.executedAt;
  const executedAt = Number.isFinite(Number(executedAtCandidate)) && Number(executedAtCandidate) > 0
    ? Number(executedAtCandidate)
    : now;
  const tokenAmount = trade.token_amount ?? trade.tokenAmount ?? null;
  const solAmount = trade.sol_amount ?? trade.solAmount ?? null;
  const feesSol = trade.fees_sol ?? trade.feesSol ?? null;
  const feesUsd = trade.fees_usd ?? trade.feesUsd ?? null;
  const solUsdPrice = trade.sol_usd_price ?? trade.solUsdPrice ?? null;
  const priceSolPerToken = trade.price_sol_per_token ?? trade.priceSolPerToken ?? null;
  const priceUsdPerToken = trade.price_usd_per_token ?? trade.priceUsdPerToken ?? null;
  const slippagePct = trade.slippage_pct ?? trade.slippagePct ?? null;
  const priceImpactPct = trade.price_impact_pct ?? trade.priceImpactPct ?? null;
  const program = trade.program ?? null;
  const evaluationPayload = trade.evaluation_payload ?? trade.evaluationPayload ?? null;
  const decisionPayload = trade.decision_payload ?? trade.decisionPayload ?? null;

  // Optional metadata
  const txid = trade.txid ?? null;
  if (!txid) {
    throw new Error(
      `[BootyBox] recordScTradeEvent requires txid (sc_trades.txid is NOT NULL + UNIQUE). wallet_id=${walletId} mint=${coinMint} side=${side}`
    );
  }
  const strategyId = trade.strategy_id ?? trade.strategyId ?? null;
  const strategyName = trade.strategy_name ?? trade.strategyName ?? null;
  const decisionLabel = trade.decision_label ?? trade.decisionLabel ?? null;
  const decisionReason = trade.decision_reason ?? trade.decisionReason ?? null;
  let sessionId = trade.session_id ?? trade.sessionId ?? null;
  if (!sessionId) {
    sessionId = getActiveSessionId({ service: 'warchest-service' });
  }

  // Position-run id
  let tradeUuid = trade.trade_uuid ?? trade.tradeUuid ?? null;

  if (!tradeUuid) {
    // 1) Prefer an OPEN run from sc_positions.
    tradeUuid = getOpenTradeUuid(walletId, coinMint);

    // 2) If there is no open run, this is a new campaign.
    //    For buys, always mint a fresh trade_uuid (do NOT reuse cached/pending UUIDs).
    if (!tradeUuid && side === 'buy') {
      tradeUuid = crypto.randomUUID();
      setTradeUuid(walletId, coinMint, tradeUuid);
    }

    // 3) For sells with no open run, fall back to any cached/pending UUID if present,
    //    otherwise create a new one so the trade is not lost (and warn).
    if (!tradeUuid && side !== 'buy') {
      tradeUuid = resolveTradeUuid(walletId, coinMint) || crypto.randomUUID();
      logger?.warn?.(
        `[BootyBox] recordScTradeEvent: using trade_uuid for ${side} with no open position-run: wallet_id=${walletId} mint=${coinMint} trade_uuid=${tradeUuid}`
      );
      setTradeUuid(walletId, coinMint, tradeUuid);
    }
  } else {
    // Ensure storage/cache knows about it
    setTradeUuid(walletId, coinMint, tradeUuid);
  }

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
      price_sol_per_token,
      price_usd_per_token,
      slippage_pct,
      price_impact_pct,
      program,
      evaluation_payload,
      decision_payload,
      fees_sol,
      fees_usd,
      sol_usd_price,
      strategy_id,
      strategy_name,
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
      @price_sol_per_token,
      @price_usd_per_token,
      @slippage_pct,
      @price_impact_pct,
      @program,
      @evaluation_payload,
      @decision_payload,
      @fees_sol,
      @fees_usd,
      @sol_usd_price,
      @strategy_id,
      @strategy_name,
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
      price_sol_per_token = COALESCE(excluded.price_sol_per_token, sc_trades.price_sol_per_token),
      price_usd_per_token = COALESCE(excluded.price_usd_per_token, sc_trades.price_usd_per_token),
      slippage_pct = COALESCE(excluded.slippage_pct, sc_trades.slippage_pct),
      price_impact_pct = COALESCE(excluded.price_impact_pct, sc_trades.price_impact_pct),
      program = COALESCE(excluded.program, sc_trades.program),
      evaluation_payload = COALESCE(excluded.evaluation_payload, sc_trades.evaluation_payload),
      decision_payload = COALESCE(excluded.decision_payload, sc_trades.decision_payload),
      fees_sol = COALESCE(excluded.fees_sol, sc_trades.fees_sol),
      fees_usd = COALESCE(excluded.fees_usd, sc_trades.fees_usd),
      sol_usd_price = COALESCE(excluded.sol_usd_price, sc_trades.sol_usd_price),
      strategy_id = COALESCE(excluded.strategy_id, sc_trades.strategy_id),
      strategy_name = COALESCE(excluded.strategy_name, sc_trades.strategy_name),
      decision_label = COALESCE(excluded.decision_label, sc_trades.decision_label),
      decision_reason = COALESCE(excluded.decision_reason, sc_trades.decision_reason),
      updated_at = excluded.updated_at
  `
  );

  if (process.env.SC_SQLITE_DIAGNOSTICS === '1') {
    try {
      // better-sqlite3 exposes the SQL text via `statement.source`.
      logger?.debug?.(`[BootyBox][recordScTradeEvent] upsert SQL: ${stmtUpsertByTxid.source}`);
    } catch (e) {
      logger?.debug?.(`[BootyBox][recordScTradeEvent] unable to read statement.source: ${e?.message || e}`);
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
    price_sol_per_token: priceSolPerToken,
    price_usd_per_token: priceUsdPerToken,
    slippage_pct: slippagePct,
    price_impact_pct: priceImpactPct,
    program,
    evaluation_payload:
      evaluationPayload == null
        ? null
        : (typeof evaluationPayload === 'string'
            ? evaluationPayload
            : JSON.stringify(evaluationPayload)),
    decision_payload:
      decisionPayload == null
        ? null
        : (typeof decisionPayload === 'string'
            ? decisionPayload
            : JSON.stringify(decisionPayload)),
    fees_sol: feesSol,
    fees_usd: feesUsd,
    sol_usd_price: solUsdPrice,
    strategy_id: strategyId,
    strategy_name: strategyName,
    decision_label: decisionLabel,
    decision_reason: decisionReason,
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

  // Keep sc_positions in sync using the new trading-domain applier.
  try {
    if (typeof applyScTradeEventToPositions === 'function') {
      applyScTradeEventToPositions({
        ...trade,
        wallet_id: walletId,
        wallet_alias: walletAlias,
        coin_mint: coinMint,
        trade_uuid: tradeUuid,
        executed_at: executedAt,
        token_amount: tokenAmount,
        sol_amount: solAmount,
        fees_sol: feesSol,
        fees_usd: feesUsd,
        sol_usd_price: solUsdPrice,
      });
    }
  } catch (err) {
    logger?.warn?.(`[BootyBox] applyScTradeEventToPositions failed: ${err?.message || err}`);
  }

  // Return best-effort inserted/updated trade row
  const row = db.prepare('SELECT * FROM sc_trades WHERE txid = ?').get(txid);

  return row || { id: info.lastInsertRowid, ...params };
}

module.exports = recordScTradeEvent;
