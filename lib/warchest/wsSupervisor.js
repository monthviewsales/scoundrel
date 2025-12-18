'use strict';

/**
 * @typedef {Object} WsSupervisorConfig
 * @property {number} [staleAfterMs] - Consider WS stale when no slot event seen for this long.
 * @property {number} [minRestartGapMs] - Minimum delay between restarts.
 * @property {number} [maxBackoffMs] - Maximum restart backoff delay.
 * @property {() => number} [now] - Time provider (ms since epoch) for tests.
 */

/**
 * @typedef {Object} WsSupervisorStatus
 * @property {number} restarts
 * @property {number|null} lastRestartAt
 * @property {string|null} lastRestartReason
 * @property {string|null} lastError
 * @property {number|null} lastErrorAt
 * @property {number} backoffMs
 * @property {boolean} restartInFlight
 */

/**
 * Create a small state machine to decide when to restart a WS-based subscription client.
 *
 * This does not own sockets; it only tracks staleness/error state and enforces cooldown/backoff.
 *
 * @param {WsSupervisorConfig} [config]
 * @returns {{
 *   getStatus: () => WsSupervisorStatus,
 *   noteError: (err: unknown, context?: string) => void,
 *   shouldRestartForStale: (lastSlotAt: number|null|undefined) => { shouldRestart: boolean, reason: string|null },
 *   beginRestart: (reason: string) => boolean,
 *   endRestart: (ok: boolean, err?: unknown) => void,
 * }}
 */
function createWsSupervisor(config = {}) {
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const staleAfterMs =
    Number.isFinite(config.staleAfterMs) && config.staleAfterMs > 0
      ? Math.trunc(config.staleAfterMs)
      : 20_000;
  const minRestartGapMs =
    Number.isFinite(config.minRestartGapMs) && config.minRestartGapMs > 0
      ? Math.trunc(config.minRestartGapMs)
      : 30_000;
  const maxBackoffMs =
    Number.isFinite(config.maxBackoffMs) && config.maxBackoffMs > 0
      ? Math.trunc(config.maxBackoffMs)
      : 5 * 60_000;

  /** @type {WsSupervisorStatus} */
  const status = {
    restarts: 0,
    lastRestartAt: null,
    lastRestartReason: null,
    lastError: null,
    lastErrorAt: null,
    backoffMs: 0,
    restartInFlight: false,
  };

  function getStatus() {
    return { ...status };
  }

  function noteError(err, context) {
    const message = err && typeof err === 'object' && err.message ? err.message : String(err);
    const ctx = context ? `${context}: ` : '';
    status.lastError = `${ctx}${message}`;
    status.lastErrorAt = now();
  }

  function canRestart() {
    const t = now();
    if (status.restartInFlight) return false;
    if (status.lastRestartAt == null) return true;
    const elapsed = t - status.lastRestartAt;
    return elapsed >= Math.max(minRestartGapMs, status.backoffMs);
  }

  function shouldRestartForStale(lastSlotAt) {
    if (lastSlotAt == null) {
      return { shouldRestart: false, reason: null };
    }

    const lastSlotAtNum = Number(lastSlotAt);
    if (!Number.isFinite(lastSlotAtNum) || lastSlotAtNum <= 0) {
      return { shouldRestart: false, reason: null };
    }

    const ageMs = now() - lastSlotAtNum;
    if (ageMs < staleAfterMs) return { shouldRestart: false, reason: null };
    if (!canRestart()) return { shouldRestart: false, reason: null };
    return { shouldRestart: true, reason: `ws_stale_${Math.trunc(ageMs)}ms` };
  }

  function beginRestart(reason) {
    if (!canRestart()) return false;
    status.restartInFlight = true;
    status.lastRestartAt = now();
    status.lastRestartReason = reason || 'unknown';
    status.restarts += 1;
    return true;
  }

  function endRestart(ok, err) {
    status.restartInFlight = false;

    if (ok) {
      status.backoffMs = 0;
      return;
    }

    if (err) noteError(err, 'restart');
    const next = status.backoffMs > 0 ? status.backoffMs * 2 : 2_000;
    status.backoffMs = Math.min(next, maxBackoffMs);
  }

  return {
    getStatus,
    noteError,
    shouldRestartForStale,
    beginRestart,
    endRestart,
  };
}

module.exports = { createWsSupervisor };
