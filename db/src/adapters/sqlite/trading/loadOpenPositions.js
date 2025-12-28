'use strict';

/**
 * Create a prepared open-positions query for a sqlite db instance.
 *
 * Why: Percent-based sells (e.g. -s 100%) should size against a single,
 * unambiguous position run.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {(walletAlias: string) => { rows: Array<object> }}
 */
  async function loadOpenPositions(db) {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[BootyBox] loadOpenPositions requires a sqlite db instance');
    }

    const stmt = db.prepare(`
      SELECT *
      FROM sc_positions
      WHERE wallet_alias = ?
        AND COALESCE(current_token_amount, 0) > 0
        AND COALESCE(closed_at, 0) = 0
    `);

    return function loadOpenPositions(walletAlias) {
      if (!walletAlias || typeof walletAlias !== 'string') {
        return { rows: [] };
      }

      const rows = stmt.all(walletAlias);
      return { rows };
    };
  };

  module.exports = loadOpenPositions;