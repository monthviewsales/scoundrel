'use strict';

const { db } = require('../context');

/**
 * Get open-position token amount for a wallet alias + mint.
 *
 * Used for percent-based sells where the CLI surface provides `wallet_alias`
 * and `coin_mint` but does not carry `trade_uuid`.
 *
 * @param {object} params
 * @param {string} params.walletAlias
 * @param {string} params.mint
 * @returns {Promise<number>}
 */

async function getTokenAmtByAlias({ walletAlias, mint } = {}) {
  if (!walletAlias || typeof walletAlias !== 'string') {
    throw new Error('[BootyBox] getTokenAmtByAlias requires walletAlias');
  }
  if (!mint || typeof mint !== 'string') {
    throw new Error('[BootyBox] getTokenAmtByAlias requires mint');
  }
  if (!db) {
    throw new Error('[BootyBox] getTokenAmtByAlias: db is not available from context');
  }

  const sql = `
    SELECT current_token_amount
    FROM sc_positions
    WHERE wallet_alias = ?
      AND coin_mint = ?
      AND (closed_at = 0 OR closed_at IS NULL)
    ORDER BY open_at DESC
    LIMIT 1;
  `;

  // better-sqlite3
  if (typeof db.prepare === 'function') {
    const row = db.prepare(sql).get(walletAlias, mint);
    return row && typeof row.current_token_amount === 'number'
      ? row.current_token_amount
      : 0;
  }

  // sqlite3 callback-style fallback
  if (typeof db.get === 'function') {
    return await new Promise((resolve, reject) => {
      db.get(sql, [walletAlias, mint], (err, row) => {
        if (err) return reject(err);
        resolve(row && typeof row.current_token_amount === 'number'
          ? row.current_token_amount
          : 0);
      });
    });
  }

  throw new Error('[BootyBox] getTokenAmtByAlias: unsupported db client');
};

module.exports = getTokenAmtByAlias;
