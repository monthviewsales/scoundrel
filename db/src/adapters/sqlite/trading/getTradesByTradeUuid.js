'use strict';

const { db } = require('../context');

/**
 * Fetch all trades for a given trade_uuid.
 *
 * Intended as a shared primitive for autopsy, analytics, and tooling.
 *
 * @param {string} tradeUuid
 * @param {Object} [opts]
 * @param {'asc'|'desc'} [opts.order='asc'] Order by executed_at then id.
 * @param {number} [opts.limit] Optional limit.
 * @param {number} [opts.offset] Optional offset.
 * @returns {Array<Object>} sc_trades rows
 */
function getTradesByTradeUuid(tradeUuid, opts = {}) {
  if (typeof tradeUuid !== 'string' || tradeUuid.trim().length === 0) {
    throw new TypeError('getTradesByTradeUuid(tradeUuid) requires a non-empty string');
  }

  const order = (opts.order || 'asc').toString().toLowerCase();
  const dir = order === 'desc' ? 'DESC' : 'ASC';

  const limit = opts.limit == null ? null : Number(opts.limit);
  const offset = opts.offset == null ? null : Number(opts.offset);

  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new TypeError(`getTradesByTradeUuid invalid opts.limit: ${opts.limit}`);
  }

  if (offset != null && (!Number.isFinite(offset) || offset < 0)) {
    throw new TypeError(`getTradesByTradeUuid invalid opts.offset: ${opts.offset}`);
  }

  // Build SQL with a safe, fixed direction. LIMIT/OFFSET are only included when provided.
  let sql = `
    SELECT *
    FROM sc_trades
    WHERE trade_uuid = ?
    ORDER BY executed_at ${dir}, id ${dir}
  `;

  const params = [tradeUuid.trim()];

  if (limit != null) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  if (offset != null) {
    // OFFSET requires LIMIT in SQLite; if offset is provided without limit, set a very high limit.
    if (limit == null) {
      sql += ' LIMIT -1';
    }
    sql += ' OFFSET ?';
    params.push(offset);
  }

  return db.prepare(sql).all(...params);
}

module.exports = getTradesByTradeUuid;
