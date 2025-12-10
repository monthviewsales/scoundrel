'use strict';

/**
 * Create a short summary string for a hub/HUD event.
 *
 * @param {object} event
 * @returns {string}
 */
function summarizeHubEvent(event) {
  if (!event || typeof event !== 'object') return 'event';
  const ctx = event.context || {};
  const parts = [];

  if (event.status) parts.push(String(event.status));
  if (ctx.side) parts.push(String(ctx.side));
  if (ctx.mint) parts.push(String(ctx.mint).slice(0, 8));
  if (event.txid) parts.push(String(event.txid).slice(0, 6));

  return parts.filter(Boolean).join(' ').trim() || 'event';
}

/**
 * Apply a hub/HUD event to HUD state for the appropriate wallet.
 *
 * @param {Record<string, import('./client').WalletState>} state
 * @param {object} event
 * @returns {boolean} True when the event was applied to a wallet.
 */
function applyHubEventToState(state, event) {
  if (!state || !event) return false;
  const ctx = event.context || {};
  const walletKey = ctx.wallet || ctx.walletAlias;
  const wallet = (walletKey && state[walletKey])
    || Object.values(state).find((w) => w.pubkey === walletKey);

  if (!wallet) return false;

  const summary = summarizeHubEvent(event);
  if (!wallet.recentEvents) wallet.recentEvents = [];
  wallet.recentEvents.unshift({ ts: Date.now(), summary });
  if (wallet.recentEvents.length > 5) wallet.recentEvents.length = 5;
  wallet.lastActivityTs = Date.now();
  return true;
}

module.exports = {
  applyHubEventToState,
  summarizeHubEvent,
};
