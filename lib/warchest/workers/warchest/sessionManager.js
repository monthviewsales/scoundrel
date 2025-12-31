'use strict';

/**
 * @typedef {Object} SessionState
 * @property {number|null} id
 * @property {string} serviceInstanceId
 * @property {number|null} startSlot
 * @property {number|null} startBlockTime
 * @property {number|null} startedAt
 * @property {number|null} lastHeartbeatAt
 * @property {number|null} lastHeartbeatSlot
 * @property {number|null} lastHeartbeatBlockTime
 */

/**
 * Create a session lifecycle manager for the HUD/daemon worker.
 * @param {Object} options
 * @param {any} options.bootyBox
 * @param {Object} options.logger
 * @param {Function} options.getChainState
 * @param {Function} options.closeLingeringSession
 * @param {string} options.statusPath
 * @param {string} options.serviceName
 * @param {string} options.serviceInstanceId
 * @param {Function} options.fetchSlotAnchor
 * @param {Function} options.wait
 * @returns {{ sessionState: SessionState, finalizeSession: Function, ensureSessionStarted: Function, closeStaleSession: Function }}
 */
function createSessionManager({
  bootyBox,
  logger,
  getChainState,
  closeLingeringSession,
  statusPath,
  serviceName,
  serviceInstanceId,
  fetchSlotAnchor,
  wait,
}) {
  const sessionState = {
    id: null,
    serviceInstanceId,
    startSlot: null,
    startBlockTime: null,
    startedAt: null,
    lastHeartbeatAt: null,
    lastHeartbeatSlot: null,
    lastHeartbeatBlockTime: null,
  };

  async function finalizeSession(reason = 'clean', overrides = {}) {
    if (!sessionState.id || typeof bootyBox.endSession !== 'function') return null;

    const overrideSlot = Number.isFinite(Number(overrides.slot)) ? Math.trunc(Number(overrides.slot)) : null;
    const overrideBlock = Number.isFinite(Number(overrides.blockTimeMs))
      ? Math.trunc(Number(overrides.blockTimeMs))
      : null;

    const fallbackChainSlot = getChainState()?.slot ?? null;
    const endSlot =
      overrideSlot ??
      sessionState.lastHeartbeatSlot ??
      fallbackChainSlot ??
      sessionState.startSlot ??
      null;
    const endBlockTime =
      overrideBlock ??
      sessionState.lastHeartbeatBlockTime ??
      sessionState.startBlockTime ??
      null;

    let row = null;
    try {
      row = bootyBox.endSession({
        sessionId: sessionState.id,
        endSlot,
        endBlockTime,
        reason,
      });
      logger.info(
        `[HUD] Session ${sessionState.id} closed (${reason}) slot=${endSlot ?? 'n/a'} blockTime=${endBlockTime ?? 'n/a'}`
      );
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to close session ${sessionState.id} (${reason}): ${msg}`);
    } finally {
      sessionState.id = null;
    }
    return row;
  }

  function closeStaleSession() {
    return closeLingeringSession({
      BootyBox: bootyBox,
      statusPath,
      service: serviceName,
      reason: 'crash',
    });
  }

  async function ensureSessionStarted() {
    if (sessionState.id != null) return;
    if (typeof bootyBox.startSession !== 'function') {
      logger.warn('[HUD] BootyBox.startSession unavailable; session tracking disabled.');
      return;
    }

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { slot, blockTimeMs } = await fetchSlotAnchor();
      if (slot) {
        try {
          const sessionId = bootyBox.startSession({
            service: serviceName,
            serviceInstanceId: sessionState.serviceInstanceId,
            startSlot: slot,
            startBlockTime: blockTimeMs,
          });
          const now = Date.now();
          sessionState.id = sessionId;
          sessionState.startSlot = slot;
          sessionState.startBlockTime = blockTimeMs ?? null;
          sessionState.startedAt = now;
          sessionState.lastHeartbeatSlot = slot;
          sessionState.lastHeartbeatBlockTime = blockTimeMs ?? null;
          sessionState.lastHeartbeatAt = now;
          logger.info(`[HUD] BootyBox session started (session_id=${sessionId}, slot=${slot}).`);
          return;
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.error(
            `[HUD] Failed to start BootyBox session (attempt ${attempt}/${maxAttempts}): ${msg}`
          );
          if (attempt === maxAttempts) throw err;
        }
      }

      await wait(Math.min(1000 * attempt, 5000));
    }

    throw new Error('Failed to determine Solana slot for session start.');
  }

  return {
    sessionState,
    finalizeSession,
    ensureSessionStarted,
    closeStaleSession,
  };
}

module.exports = {
  createSessionManager,
};
