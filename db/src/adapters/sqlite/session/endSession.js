'use strict';

const { db, logger } = require('../context');

function toInt(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * End an existing service-level session.
 *
 * Caller should provide current slot (and optionally block time) from RPC.
 * We also finalize rollups from sc_trades for this session_id.
 *
 * @param {Object} opts
 * @param {number} opts.sessionId sc_sessions.session_id
 * @param {number} [opts.endSlot] current RPC slot at shutdown
 * @param {number|null} [opts.endBlockTime] optional block time
 * @param {string} [opts.reason='clean'] end reason ('clean' | 'crash' | 'restart' | ...)
 * @param {number} [opts.now] ms epoch; defaults to Date.now()
 * @returns {Object|null} updated session row
 */
function endSession(opts = {}) {
  const sessionId = toInt(opts.sessionId);
  if (!sessionId) return null;

  const now = toInt(opts.now) && toInt(opts.now) > 0 ? toInt(opts.now) : Date.now();
  const endSlot = opts.endSlot === undefined || opts.endSlot === null ? null : toInt(opts.endSlot);
  const endBlockTime = opts.endBlockTime === undefined || opts.endBlockTime === null ? null : toInt(opts.endBlockTime);
  const reason = (opts.reason || 'clean').toString();

  const tx = db.transaction(() => {
    // Final rollups for this session.
    const rollup = db
      .prepare(
        `
        SELECT
          COUNT(*) AS trades_count,
          COALESCE(SUM(COALESCE(fees_usd, 0)), 0) AS fees_usd,
          COALESCE(SUM(CASE
            WHEN side = 'buy' AND sol_amount IS NOT NULL AND sol_usd_price IS NOT NULL
              THEN ABS(sol_amount) * sol_usd_price
            ELSE 0
          END), 0) AS buys_usd,
          COALESCE(SUM(CASE
            WHEN side = 'sell' AND sol_amount IS NOT NULL AND sol_usd_price IS NOT NULL
              THEN sol_amount * sol_usd_price
            ELSE 0
          END), 0) AS sells_usd
        FROM sc_trades
        WHERE session_id = ?
        `
      )
      .get(sessionId);

    const changes = db
      .prepare(
        `
        UPDATE sc_sessions
        SET
          ended_at = ?,
          end_slot = COALESCE(?, end_slot),
          end_block_time = COALESCE(?, end_block_time),
          end_reason = ?,
          -- also treat shutdown as a final refresh snapshot
          last_refresh_at = ?,
          last_refresh_slot = COALESCE(?, last_refresh_slot),
          last_refresh_block_time = COALESCE(?, last_refresh_block_time),
          trades_count = ?,
          fees_usd = ?,
          buys_usd = ?,
          sells_usd = ?,
          updated_at = ?
        WHERE session_id = ?
        `
      )
      .run(
        now,
        endSlot,
        endBlockTime,
        reason,
        now,
        endSlot,
        endBlockTime,
        toInt(rollup?.trades_count) || 0,
        toNum(rollup?.fees_usd) || 0,
        toNum(rollup?.buys_usd) || 0,
        toNum(rollup?.sells_usd) || 0,
        now,
        sessionId
      );

    if (!changes || changes.changes === 0) {
      logger?.warn?.(`[BootyBox][sessions] endSession: no session row updated for session_id=${sessionId}`);
    }

    return db.prepare('SELECT * FROM sc_sessions WHERE session_id = ?').get(sessionId);
  });

  return tx();
}

module.exports = endSession;