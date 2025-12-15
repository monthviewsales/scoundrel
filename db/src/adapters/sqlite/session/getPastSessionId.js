'use strict';

const { db } = require('../context');

/**
 * Get the session id for a service that was active at a given timestamp.
 *
 * This is used for retroactive attribution of historical trades (e.g. autopsy backfill).
 *
 * A session is considered active for a timestamp T if:
 *   started_at <= T AND (ended_at IS NULL OR ended_at >= T)
 *
 * @param {Object} opts
 * @param {string} [opts.service='warchest-service']
 * @param {number} opts.timestamp   Epoch milliseconds (preferred) or seconds
 * @returns {number|null} session_id or null if no matching session
 */
function getPastSessionId(opts = {}) {
  const service = (opts.service || 'warchest-service').toString();

  if (!opts.timestamp) {
    throw new Error('getPastSessionId requires opts.timestamp');
  }

  let ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error(`getPastSessionId invalid timestamp: ${opts.timestamp}`);
  }

  // Normalize seconds → ms if needed
  if (ts < 100000000000) {
    ts = ts * 1000;
  }

  const row = db
    .prepare(
      `
      SELECT session_id
      FROM sc_sessions
      WHERE service = ?
        AND started_at <= ?
        AND (ended_at IS NULL OR ended_at >= ?)
      ORDER BY started_at DESC
      LIMIT 1
      `
    )
    .get(service, ts, ts);

  return row ? row.session_id : null;
}

module.exports = getPastSessionId;