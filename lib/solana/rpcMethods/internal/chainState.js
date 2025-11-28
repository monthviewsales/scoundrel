'use strict';

// Simple shared chain state for slot/root heartbeat.
// Stored as a singleton so multiple modules (HUD, daemon, tests) can read/update.

const chainState = {
  slot: null,
  parent: null,
  root: null,
  lastSlotAt: null, // timestamp in ms
};

/**
 * Update chain state from a slot notification.
 * Expected event shape:
 *   { slot: 382872076n, parent: 382872075n, root: 382872044n }
 */
function updateFromSlotEvent(ev) {
  if (!ev) return;
  try {
    if (ev.slot !== undefined) chainState.slot = Number(ev.slot);
    if (ev.parent !== undefined) chainState.parent = Number(ev.parent);
    if (ev.root !== undefined) chainState.root = Number(ev.root);
    chainState.lastSlotAt = Date.now();
  } catch (_) {
    // swallow conversion errors; HUD/daemon can handle partial state
  }
}

/**
 * Get read-only view of current chain state.
 */
function getChainState() {
  return chainState;
}

module.exports = {
  updateFromSlotEvent,
  getChainState,
};
