'use strict';

const crypto = require('crypto');
const { db, logger } = require('../context');

/**
 * Start a new service-level session.
 *
 * Sessions are NOT wallet-specific. Warchest Service owns lifecycle.
 * Caller should provide current slot (and optionally block time) from RPC.
 *
 * Crash recovery:
 * - If a prior session is still open (ended_at IS NULL) for this service, it is closed as end_reason='crash'.
 * - end_slot is set to last_refresh_slot if present, otherwise the current start_slot.
 *
 * @param {Object} opts
 * @param {string} [opts.service='warchest-service']
 * @param {string} [opts.serviceInstanceId] UUID per process start
 * @param {number} opts.startSlot current RPC slot at service start
 * @param {number|null} [opts.startBlockTime] optional block time (unix seconds or ms; stored as provided)
 * @param {number} [opts.startedAt] ms epoch; defaults to Date.now()
 * @returns {number} session_id
 */
function startSession(opts = {}) {
  const now = Number.isFinite(Number(opts.startedAt)) && Number(opts.startedAt) > 0 ? Number(opts.startedAt) : Date.now();
  const service = (opts.service || 'warchest-service').toString();

  const startSlot = Number(opts.startSlot);
  if (!Number.isFinite(startSlot) || startSlot <= 0) {
    throw new Error(`[BootyBox][sessions] startSession requires a valid startSlot (got: ${opts.startSlot})`);
  }

  const startBlockTime = opts.startBlockTime === undefined || opts.startBlockTime === null
    ? null
    : Number(opts.startBlockTime);

  const serviceInstanceId = (opts.serviceInstanceId || crypto.randomUUID()).toString();

  const tx = db.transaction(() => {
    // If an old session is still open for this service, close it as a crash.
    const open = db
      .prepare(
        `SELECT session_id, last_refresh_slot, last_refresh_block_time
         FROM sc_sessions
         WHERE service = ? AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(service);

    if (open) {
      const endSlot = Number.isFinite(Number(open.last_refresh_slot)) && Number(open.last_refresh_slot) > 0
        ? Number(open.last_refresh_slot)
        : startSlot;
      const endBlockTime = Number.isFinite(Number(open.last_refresh_block_time))
        ? Number(open.last_refresh_block_time)
        : startBlockTime;

      db.prepare(
        `UPDATE sc_sessions
         SET ended_at = ?, end_slot = ?, end_block_time = ?, end_reason = 'crash', updated_at = ?
         WHERE session_id = ?`
      ).run(now, endSlot, endBlockTime, now, open.session_id);

      logger?.warn?.(
        `[BootyBox][sessions] startSession: closed stale open session as crash: service=${service} session_id=${open.session_id} end_slot=${endSlot}`
      );
    }

    const res = db
      .prepare(
        `INSERT INTO sc_sessions (
           service,
           service_instance_id,
           started_at,
           start_slot,
           start_block_time,
           last_refresh_at,
           last_refresh_slot,
           last_refresh_block_time,
           created_at,
           updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        service,
        serviceInstanceId,
        now,
        startSlot,
        startBlockTime,
        now,
        startSlot,
        startBlockTime,
        now,
        now
      );

    return res.lastInsertRowid;
  });

  return tx();
}

module.exports = startSession;