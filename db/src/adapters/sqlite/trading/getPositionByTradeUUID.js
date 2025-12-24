'use strict';

/**
 * Fetch the current open position for a given trade run.
 *
 * Why: Percent-based sells (e.g. -s 100%) should size against a single,
 * unambiguous position run. `trade_uuid` is unique for a wallet+mint run.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {(tradeUuid: string) => (object|null)}
 */
module.exports = function makeGetPositionByTradeUUID(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('[BootyBox] getPositionByTradeUUID requires a sqlite db instance');
  }

  const stmt = db.prepare(`
    SELECT
      position_id,
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
    FROM sc_positions
    WHERE trade_uuid = ?
      AND (closed_at = 0 OR closed_at IS NULL)
    ORDER BY open_at DESC
    LIMIT 1;
  `);

  return function getPositionByTradeUUID(tradeUuid) {
    if (!tradeUuid || typeof tradeUuid !== 'string') {
      return null;
    }

    const row = stmt.get(tradeUuid);
    return row || null;
  };
};