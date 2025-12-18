'use strict';

const { db, logger } = require('../context');

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeAdd(a, b) {
  const na = toNum(a);
  const nb = toNum(b);
  if (na === null && nb === null) return null;
  return (na || 0) + (nb || 0);
}

function safeSub(a, b) {
  const na = toNum(a);
  const nb = toNum(b);
  if (na === null && nb === null) return null;
  return (na || 0) - (nb || 0);
}

function calcTradePriceSol(solAmount, tokenAmount) {
  const sol = toNum(solAmount);
  const tok = toNum(tokenAmount);
  if (!sol || !tok) return null;
  if (tok === 0) return null;
  return Math.abs(sol) / tok;
}

function calcTradePriceUsd(solAmount, tokenAmount, solUsdPrice) {
  const pSol = calcTradePriceSol(solAmount, tokenAmount);
  const solUsd = toNum(solUsdPrice);
  if (pSol === null || solUsd === null) return null;
  return pSol * solUsd;
}

/**
 * Apply a sc_trades insert to sc_positions.
 *
 * Invariants:
 * - At most one open position per (wallet_id, coin_mint) (enforced by partial unique index).
 * - trade_uuid identifies a position-run (first buy -> last sell). It is stored on the open row.
 *
 * This function is intentionally conservative: it updates only fields needed for tracking and HUD.
 * PnL rollups are handled by DB triggers on sc_trades.
 *
 * @param {Object} trade
 * @returns {Object} Updated/created position row.
 */
function applyScTradeEventToPositions(trade) {
  if (!trade || typeof trade !== 'object') {
    throw new TypeError('applyScTradeEventToPositions(trade) requires a trade object');
  }

  const now = Date.now();

  if (process.env.SC_SQLITE_DIAGNOSTICS === '1') {
    logger?.debug?.(`[BootyBox][applyScTradeEventToPositions] trade=${JSON.stringify(trade)}`);
  }

  const walletId = trade.wallet_id ?? trade.walletId;
  const walletAlias = trade.wallet_alias ?? trade.walletAlias ?? null;
  const coinMint = trade.coin_mint ?? trade.coinMint;
  const side = trade.side;
  const tradeUuid = trade.trade_uuid ?? trade.tradeUuid ?? null;

  if (!walletId || !coinMint || !side) {
    throw new Error(
      `applyScTradeEventToPositions missing required fields: wallet_id=${walletId}, coin_mint=${coinMint}, side=${side}`
    );
  }

  const executedAtCandidate = trade.executed_at ?? trade.executedAt;
  const executedAt = Number.isFinite(Number(executedAtCandidate)) && Number(executedAtCandidate) > 0
    ? Number(executedAtCandidate)
    : now;
  const tokenAmount = toNum(trade.token_amount ?? trade.tokenAmount) || 0;
  const solAmount = toNum(trade.sol_amount ?? trade.solAmount) || 0;
  const solUsdPrice = toNum(trade.sol_usd_price ?? trade.solUsdPrice);

  const strategyId = trade.strategy_id ?? trade.strategyId ?? null;
  const strategyName = trade.strategy_name ?? trade.strategyName ?? null;
  const source = trade.source ?? null;

  const lastPriceSol = calcTradePriceSol(solAmount, tokenAmount);
  const lastPriceUsd = calcTradePriceUsd(solAmount, tokenAmount, solUsdPrice);

  const getOpen = db.prepare(
    'SELECT * FROM sc_positions WHERE wallet_id = ? AND coin_mint = ? AND closed_at = 0'
  );

  const insertOpen = db.prepare(
    `
    INSERT INTO sc_positions (
      wallet_id,
      wallet_alias,
      coin_mint,
      trade_uuid,
      strategy_id,
      strategy_name,
      open_at,
      closed_at,
      last_trade_at,
      last_updated_at,
      entry_token_amount,
      current_token_amount,
      total_tokens_bought,
      total_tokens_sold,
      entry_price_sol,
      entry_price_usd,
      last_price_sol,
      last_price_usd,
      source
    ) VALUES (
      @wallet_id,
      @wallet_alias,
      @coin_mint,
      @trade_uuid,
      @strategy_id,
      @strategy_name,
      @open_at,
      @closed_at,
      @last_trade_at,
      @last_updated_at,
      @entry_token_amount,
      @current_token_amount,
      @total_tokens_bought,
      @total_tokens_sold,
      @entry_price_sol,
      @entry_price_usd,
      @last_price_sol,
      @last_price_usd,
      @source
    )
  `
  );

  const updateOpen = db.prepare(
    `
    UPDATE sc_positions
    SET
      wallet_alias = COALESCE(@wallet_alias, wallet_alias),
      trade_uuid = COALESCE(@trade_uuid, trade_uuid),
      strategy_id = COALESCE(@strategy_id, strategy_id),
      strategy_name = COALESCE(@strategy_name, strategy_name),
      last_trade_at = @last_trade_at,
      last_updated_at = @last_updated_at,
      entry_token_amount = COALESCE(entry_token_amount, @entry_token_amount),
      current_token_amount = @current_token_amount,
      total_tokens_bought = @total_tokens_bought,
      total_tokens_sold = @total_tokens_sold,
      entry_price_sol = COALESCE(entry_price_sol, @entry_price_sol),
      entry_price_usd = COALESCE(entry_price_usd, @entry_price_usd),
      last_price_sol = COALESCE(@last_price_sol, last_price_sol),
      last_price_usd = COALESCE(@last_price_usd, last_price_usd),
      source = COALESCE(@source, source)
    WHERE position_id = @position_id
  `
  );

  const closeOpen = db.prepare(
    'UPDATE sc_positions SET closed_at = ?, last_updated_at = ? WHERE position_id = ?'
  );

  const tx = db.transaction(() => {
    const open = getOpen.get(walletId, coinMint);

    // If we have no open position, create one.
    // For buys: open with tokenAmount.
    // For sells without an open position: create a row so the trade_uuid has a home, but mark as zero/closed.
    if (!open) {
      const isBuy = side === 'buy';
      const initialTokens = isBuy ? tokenAmount : 0;

      const params = {
        wallet_id: walletId,
        wallet_alias: walletAlias,
        coin_mint: coinMint,
        trade_uuid: tradeUuid,
        strategy_id: strategyId,
        strategy_name: strategyName,
        open_at: executedAt,
        closed_at: 0,
        last_trade_at: executedAt,
        last_updated_at: now,
        entry_token_amount: isBuy ? tokenAmount : null,
        current_token_amount: initialTokens,
        total_tokens_bought: isBuy ? tokenAmount : 0,
        total_tokens_sold: isBuy ? 0 : tokenAmount,
        entry_price_sol: isBuy ? lastPriceSol : null,
        entry_price_usd: isBuy ? lastPriceUsd : null,
        last_price_sol: lastPriceSol,
        last_price_usd: lastPriceUsd,
        source,
      };

      const info = insertOpen.run(params);
      const created = db.prepare('SELECT * FROM sc_positions WHERE position_id = ?').get(info.lastInsertRowid);

      // If this was a sell with no open position, immediately close it.
      if (!isBuy) {
        closeOpen.run(executedAt, now, created.position_id);
        return db.prepare('SELECT * FROM sc_positions WHERE position_id = ?').get(created.position_id);
      }

      return created;
    }

    // Update existing open position.
    const isBuy = side === 'buy';

    const newCurrent = isBuy
      ? safeAdd(open.current_token_amount, tokenAmount)
      : safeSub(open.current_token_amount, tokenAmount);

    const newBought = isBuy ? safeAdd(open.total_tokens_bought, tokenAmount) : open.total_tokens_bought;
    const newSold = !isBuy ? safeAdd(open.total_tokens_sold, tokenAmount) : open.total_tokens_sold;

    updateOpen.run({
      position_id: open.position_id,
      wallet_alias: walletAlias,
      trade_uuid: tradeUuid,
      strategy_id: strategyId,
      strategy_name: strategyName,
      last_trade_at: executedAt,
      last_updated_at: now,
      entry_token_amount: isBuy ? tokenAmount : null,
      current_token_amount: newCurrent,
      total_tokens_bought: newBought,
      total_tokens_sold: newSold,
      entry_price_sol: isBuy ? lastPriceSol : null,
      entry_price_usd: isBuy ? lastPriceUsd : null,
      last_price_sol: lastPriceSol,
      last_price_usd: lastPriceUsd,
      source,
    });

    // Close if we've effectively sold out.
    const eps = 1e-9;
    const cur = toNum(newCurrent) || 0;
    if (cur <= eps) {
      // Clamp to zero on close to avoid negative dust / out-of-order sells leaving negatives behind.
      db.prepare('UPDATE sc_positions SET current_token_amount = 0 WHERE position_id = ?').run(open.position_id);
      closeOpen.run(executedAt, now, open.position_id);
    }

    return db.prepare('SELECT * FROM sc_positions WHERE position_id = ?').get(open.position_id);
  });

  try {
    return tx();
  } catch (err) {
    logger?.warn?.(`[BootyBox] applyScTradeEventToPositions error: ${err?.stack || err?.message || err}`);
    throw err;
  }
}

module.exports = applyScTradeEventToPositions;