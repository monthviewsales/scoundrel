'use strict';

/**
 * Build snapshot/persistence helpers for monitor workers.
 *
 * @param {Object} opts
 * @param {Function} [opts.writeStatusSnapshot] - Optional status writer from warchest client.
 * @param {string} [opts.mint] - Mint being monitored (included in snapshots).
 * @param {string} [opts.walletAlias] - Wallet alias being monitored.
 * @returns {{snapshot: Function}}
 */
function createMonitorPersistence(opts = {}) {
  const { writeStatusSnapshot } = opts;
  const mint = opts.mint || null;
  const walletAlias = opts.walletAlias || null;

  /**
   * Persist a lightweight status snapshot for the coin monitor.
   *
   * @param {Object} status
   * @param {string} status.stopReason
   * @param {number} status.balance
   * @param {Array} status.accounts
   */
  function snapshot(status) {
    if (typeof writeStatusSnapshot === 'function') {
      writeStatusSnapshot({
        component: 'coinMonitor',
        mint,
        walletAlias,
        stopReason: status.stopReason,
        balance: status.balance,
        accounts: status.accounts,
      });
    }
  }

  return { snapshot };
}

module.exports = { createMonitorPersistence };
