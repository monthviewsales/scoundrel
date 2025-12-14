'use strict';

const fs = require('fs');

function pickNumeric(candidates) {
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.trunc(num);
  }
  return null;
}

/**
 * Read a JSON status snapshot from disk (best-effort).
 *
 * @param {string} statusPath
 * @returns {Object|null}
 */
function readStatusSnapshot(statusPath) {
  if (!statusPath) return null;
  try {
    if (!fs.existsSync(statusPath)) return null;
    const raw = fs.readFileSync(statusPath, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Determine the best end slot/blockTime based on legacy status snapshots and/or the active session row.
 *
 * @param {Object|null} snapshot Parsed status snapshot ({ health: {...} })
 * @param {Object|null} sessionRow sc_sessions row
 * @returns {{slot: number|null, blockTimeMs: number|null}}
 */
function deriveSessionCloseAnchors(snapshot, sessionRow) {
  const health = snapshot && snapshot.health ? snapshot.health : null;
  const sessionHealth = health && health.session ? health.session : null;
  const ws = health && health.ws ? health.ws : null;

  const slot = pickNumeric([
    sessionHealth && sessionHealth.lastRefreshSlot,
    sessionHealth && sessionHealth.lastSlot,
    ws && ws.slot,
    sessionRow && sessionRow.last_refresh_slot,
    sessionRow && sessionRow.start_slot,
  ]);

  const blockTimeMs = pickNumeric([
    sessionHealth && sessionHealth.lastRefreshBlockTime,
    sessionHealth && sessionHealth.lastBlockTimeMs,
    ws && ws.blockTimeMs,
    sessionRow && sessionRow.last_refresh_block_time,
    sessionRow && sessionRow.start_block_time,
  ]);

  return { slot, blockTimeMs };
}

/**
 * Close an open session (if present) using last-known anchors from the status file.
 *
 * @param {Object} opts
 * @param {Object} opts.BootyBox - Initialized BootyBox adapter.
 * @param {string} opts.statusPath - Path to data/warchest/status.json (or override).
 * @param {string} [opts.service='warchest-service'] - Session service name.
 * @param {string} [opts.reason='crash'] - end_reason applied to the closed session.
 * @param {number} [opts.now=Date.now()] - Timestamp override for deterministic tests.
 * @returns {{closed:boolean, snapshot:Object|null, anchors:{slot:number|null, blockTimeMs:number|null}, session:Object|null}}
 */
function closeLingeringSession(opts = {}) {
  const {
    BootyBox,
    statusPath,
    service = 'warchest-service',
    reason = 'crash',
    now = Date.now(),
  } = opts;

  const snapshot = readStatusSnapshot(statusPath);

  if (
    !BootyBox ||
    typeof BootyBox.getActiveSession !== 'function' ||
    typeof BootyBox.endSession !== 'function'
  ) {
    return {
      closed: false,
      snapshot,
      anchors: { slot: null, blockTimeMs: null },
      session: null,
    };
  }

  const active = BootyBox.getActiveSession({ service });
  if (!active) {
    return {
      closed: false,
      snapshot,
      anchors: { slot: null, blockTimeMs: null },
      session: null,
    };
  }

  const anchors = deriveSessionCloseAnchors(snapshot, active);
  const slot = anchors.slot ?? (Number.isFinite(Number(active.start_slot)) ? Math.trunc(Number(active.start_slot)) : null);
  const blockTimeMs =
    anchors.blockTimeMs ??
    (Number.isFinite(Number(active.start_block_time)) ? Math.trunc(Number(active.start_block_time)) : null);

  const session = BootyBox.endSession({
    sessionId: active.session_id,
    endSlot: slot,
    endBlockTime: blockTimeMs,
    reason,
    now,
  });

  return {
    closed: true,
    snapshot,
    anchors: { slot, blockTimeMs },
    session,
  };
}

module.exports = {
  readStatusSnapshot,
  deriveSessionCloseAnchors,
  closeLingeringSession,
};
