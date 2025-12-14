'use strict';

const { db } = require('../context');

/**
 * Get the active (open) session id for a service.
 *
 * Sessions are service-level. At most one open session per service is enforced
 * by a partial unique index (ended_at IS NULL).
 *
 * @param {Object} opts
 * @param {string} [opts.service='warchest-service']
 * @returns {number|null} session_id or null if none active
 */
function getActiveSessionId(opts = {}) {
  const service = (opts.service || 'warchest-service').toString();

  const row = db
    .prepare(
      `
      SELECT session_id
      FROM sc_sessions
      WHERE service = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
      `
    )
    .get(service);

  return row ? row.session_id : null;
}

module.exports = getActiveSessionId;