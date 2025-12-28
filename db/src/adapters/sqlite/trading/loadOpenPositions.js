'use strict';

const { db } = require('../context');

/**
 * Load open positions for a wallet alias using the sqlite db from context.
 *
 * Contract: returns an object with a `rows` array (never null).
 *
 * @param {string} walletAlias
 * @returns {{ rows: Array<object> }}
 */

if (!db) throw new Error('[BootyBox] loadOpenPositions: db is not available from context');
if (typeof db.prepare !== 'function') {
  throw new Error('[BootyBox] loadOpenPositions requires a sqlite db instance');
}

const stmt = db.prepare(`
  SELECT *
  FROM sc_positions
  WHERE wallet_alias = ?
    AND COALESCE(current_token_amount, 0) > 0
    AND COALESCE(closed_at, 0) = 0
`);

function loadOpenPositions(walletAlias) {
  if (!walletAlias || typeof walletAlias !== 'string') {
    return { rows: [] };
  }

  const rows = stmt.all(walletAlias);
  return { rows };
}

module.exports = loadOpenPositions;