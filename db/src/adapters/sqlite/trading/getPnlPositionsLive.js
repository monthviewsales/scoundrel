const { db } = require('../context');

/**
 * Query the live PnL view for one wallet (optionally filtered by coin mint).
 *
 * @param {object} params
 * @param {number} params.walletId
 * @param {string=} params.coinMint
 * @returns {Promise<Array<object>>}
 */
async function getPnlPositionsLive({ walletId, coinMint } = {}) {
  if (!walletId) throw new Error('[BootyBox] getPnlPositionsLive requires walletId');

  // Support both styles of context exports.
  if (!db) throw new Error('[BootyBox] getPnlPositionsLive: db is not available from context');

  const sqlBase = `
    SELECT
      wallet_id,
      wallet_alias,
      coin_mint,
      trade_uuid,
      total_tokens_bought,
      total_tokens_sold,
      total_sol_spent,
      total_sol_received,
      fees_sol,
      fees_usd,
      avg_cost_sol,
      avg_cost_usd,
      realized_sol,
      realized_usd,
      current_token_amount,
      coin_price_sol,
      coin_price_usd,
      unrealized_sol,
      unrealized_usd,
      total_sol,
      total_usd,
      first_trade_at,
      last_trade_at,
      last_updated_at
    FROM sc_pnl_positions_live
    WHERE wallet_id = ?
  `;

  const args = [walletId];
  const sql = coinMint ? `${sqlBase} AND coin_mint = ?` : sqlBase;
  if (coinMint) args.push(coinMint);

  // Prefer better-sqlite3 style.
  if (typeof db.prepare === 'function') {
    return db.prepare(sql).all(...args);
  }

  // Fallback: sqlite3 style callback API.
  if (typeof db.all === 'function') {
    return await new Promise((resolve, reject) => {
      db.all(sql, args, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  throw new Error('[BootyBox] getPnlPositionsLive: unsupported db client');
}

module.exports = getPnlPositionsLive;