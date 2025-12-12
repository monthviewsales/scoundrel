'use strict';

const crypto = require('crypto');
const {
  db,
  logger,
  resolveTradeUuid,
  setTradeUuid,
} = require('../context');

// For now we still reuse the legacy position applier until we extract it too.
// This keeps behavior consistent while we peel the monolith apart.
const legacy = require('../legacyAdapter');

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
  const executedAt = trade.executed_at ?? trade.executedAt ?? now;
  const tokenAmount = trade.token_amount ?? trade.tokenAmount ?? null;
  const solAmount = trade.sol_amount ?? trade.solAmount ?? null;
  const feesSol = trade.fees_sol ?? trade.feesSol ?? null;
  const feesUsd = trade.fees_usd ?? trade.feesUsd ?? null;
  const solUsdPrice = trade.sol_usd_price ?? trade.solUsdPrice ?? null;

  // Optional metadata
  const txid = trade.txid ?? null;
  const strategyId = trade.strategy_id ?? trade.strategyId ?? null;
  const strategyName = trade.strategy_name ?? trade.strategyName ?? null;
  const decisionLabel = trade.decision_label ?? trade.decisionLabel ?? null;
  const decisionReason = trade.decision_reason ?? trade.decisionReason ?? null;
  const sessionId = trade.session_id ?? trade.sessionId ?? null;

  // Position-run id
  let tradeUuid = trade.trade_uuid ?? trade.tradeUuid ?? null;
  if (!tradeUuid) {
    tradeUuid = resolveTradeUuid(walletId, coinMint);

    if (!tradeUuid) {
      tradeUuid = crypto.randomUUID();
      if (side !== 'buy') {
        logger?.warn?.(
          `[BootyBox] recordScTradeEvent: created new trade_uuid for ${side} with no open position-run: wallet_id=${walletId} mint=${coinMint}`
        );
      }

      // Persist for the open position-run (if it exists) or stash in pending_trade_uuids.
      setTradeUuid(walletId, coinMint, tradeUuid);
    }
  } else {
    // Ensure storage/cache knows about it
    setTradeUuid(walletId, coinMint, tradeUuid);
  }

  // Insert trade
  const stmt = db.prepare(
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
  `
  );

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

  const info = stmt.run(params);

  // Keep sc_positions in sync using the current legacy applier until we extract it.
  try {
    if (typeof legacy.applyScTradeEventToPositions === 'function') {
      legacy.applyScTradeEventToPositions({
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

  // Return best-effort inserted trade row
  const row = db
    .prepare('SELECT * FROM sc_trades WHERE id = ?')
    .get(info.lastInsertRowid);

  return row || { id: info.lastInsertRowid, ...params };
}

module.exports = recordScTradeEvent;
