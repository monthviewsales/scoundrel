'use strict';

const { db } = require('../context');

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
 * Update session refresh fields (time/slot) and recompute session rollups.
 *
 * This function is called explicitly by the Warchest service during its refresh loop.
 * Sessions are service-level (not wallet-specific).
 *
 * @param {Object} opts
 * @param {number} opts.sessionId sc_sessions.session_id
 * @param {number} opts.currentSlot current RPC slot
 * @param {number|null} [opts.currentBlockTime] optional block time (stored as provided)
 * @param {number} [opts.now] ms epoch; defaults to Date.now()
 * @returns {Object|null} updated sc_sessions row (or null if sessionId missing)
 */
function updateSessionStats(opts = {}) {
  const sessionId = toInt(opts.sessionId);
  if (!sessionId) return null;

  const nowCandidate = toInt(opts.now);
  const now = nowCandidate && nowCandidate > 0 ? nowCandidate : Date.now();
  const currentSlot = toInt(opts.currentSlot);
  if (!currentSlot || currentSlot <= 0) {
    throw new Error(`[BootyBox][sessions] updateSessionStats requires a valid currentSlot (got: ${opts.currentSlot})`);
  }

  const currentBlockTimeCandidate = toInt(opts.currentBlockTime);
  const currentBlockTime = currentBlockTimeCandidate && currentBlockTimeCandidate > 0
    ? currentBlockTimeCandidate
    : null;

  const tx = db.transaction(() => {
    // Rollups for this session.
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

    db.prepare(
      `
      UPDATE sc_sessions
      SET
        last_refresh_at = ?,
        last_refresh_slot = ?,
        last_refresh_block_time = ?,
        trades_count = ?,
        fees_usd = ?,
        buys_usd = ?,
        sells_usd = ?,
        updated_at = ?
      WHERE session_id = ?
      `
    ).run(
      now,
      currentSlot,
      currentBlockTime,
      toInt(rollup?.trades_count) || 0,
      toNum(rollup?.fees_usd) || 0,
      toNum(rollup?.buys_usd) || 0,
      toNum(rollup?.sells_usd) || 0,
      now,
      sessionId
    );

    return db.prepare('SELECT * FROM sc_sessions WHERE session_id = ?').get(sessionId);
  });

  return tx();
}

module.exports = updateSessionStats;