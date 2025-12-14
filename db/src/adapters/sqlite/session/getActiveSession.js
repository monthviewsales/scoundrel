'use strict';

const { db } = require('../context');

/**
 * Get the active (open) session row for a service.
 *
 * Sessions are service-level. At most one open session per service is enforced
 * by a partial unique index (ended_at IS NULL).
 *
 * @param {Object} opts
 * @param {string} [opts.service='warchest-service']
 * @returns {Object|null} sc_sessions row or null if none active
 */
function getActiveSession(opts = {}) {
  const service = (opts.service || 'warchest-service').toString();

  const row = db
    .prepare(
      `
      SELECT *
      FROM sc_sessions
      WHERE service = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
      `
    )
    .get(service);

  return row || null;
}

module.exports = getActiveSession;