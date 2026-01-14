"use strict";

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_FORCE_WAIT_MS = 2_000;
const DEFAULT_STOP_SIGNAL = "SIGTERM";
const DEFAULT_FORCE_SIGNAL = "SIGKILL";
const DEFAULT_POLL_MS = 200;

function isPidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function waitForPidExit(pid, timeoutMs, pollMs) {
  const waitMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : 0;
  const poll = Number.isFinite(Number(pollMs))
    ? Math.max(25, Number(pollMs))
    : DEFAULT_POLL_MS;

  if (!pid) return Promise.resolve(true);
  if (!isPidAlive(pid)) return Promise.resolve(true);
  if (waitMs <= 0) return Promise.resolve(false);

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (!isPidAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= waitMs) {
        resolve(false);
        return;
      }
      setTimeout(check, poll);
    };
    check();
  });
}

function waitForChildExit(child, timeoutMs) {
  const waitMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : 0;
  if (!child) return Promise.resolve(true);
  if (child.exitCode != null) return Promise.resolve(true);
  if (waitMs <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      resolve(false);
    }, waitMs);

    function onExit() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }

    child.once("exit", onExit);
  });
}

function killPid(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), signal);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @typedef {Object} ShutdownCoordinator
 * @property {Function} trackWorker
 * @property {Function} trackPid
 * @property {Function} trackCleanup
 * @property {Function} shutdown
 */

/**
 * Create a shutdown coordinator to stop and reap child processes.
 *
 * @param {Object} options
 * @param {Object} [options.logger]
 * @param {string} [options.label]
 * @param {number} [options.defaultGraceMs]
 * @param {number} [options.defaultWaitMs]
 * @param {number} [options.defaultForceWaitMs]
 * @param {string} [options.defaultForceSignal]
 * @param {number} [options.pollIntervalMs]
 * @returns {ShutdownCoordinator}
 */
function createShutdownCoordinator(options = {}) {
  const entries = [];
  const trackedPids = new Set();
  const label = options.label ? String(options.label) : "shutdown";
  const log = options.logger || null;
  const defaultGraceMs = Number.isFinite(Number(options.defaultGraceMs))
    ? Number(options.defaultGraceMs)
    : DEFAULT_GRACE_MS;
  const defaultWaitMs = Number.isFinite(Number(options.defaultWaitMs))
    ? Number(options.defaultWaitMs)
    : DEFAULT_WAIT_MS;
  const defaultForceWaitMs = Number.isFinite(Number(options.defaultForceWaitMs))
    ? Number(options.defaultForceWaitMs)
    : DEFAULT_FORCE_WAIT_MS;
  const defaultForceSignal = options.defaultForceSignal || DEFAULT_FORCE_SIGNAL;
  const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs))
    ? Number(options.pollIntervalMs)
    : DEFAULT_POLL_MS;
  let shutdownPromise = null;

  function trackWorker(name, handle, trackOptions = {}) {
    if (!handle) return null;
    const pid = handle.pid || handle.child?.pid || null;
    if (pid && trackedPids.has(pid)) return handle;
    if (pid) trackedPids.add(pid);

    const entry = {
      name: name || "worker",
      pid,
      stop: (reason) => {
        if (trackOptions.skipStop) return;
        if (typeof handle.stop === "function") {
          handle.stop(reason || null, {
            graceMs: trackOptions.graceMs ?? defaultGraceMs,
            signal: trackOptions.signal || DEFAULT_STOP_SIGNAL,
            force: trackOptions.force === true,
          });
        }
      },
      wait: (timeoutMs) => {
        if (handle.child) {
          return waitForChildExit(handle.child, timeoutMs);
        }
        if (pid) {
          return waitForPidExit(pid, timeoutMs, pollIntervalMs);
        }
        return Promise.resolve(true);
      },
      forceKill: (signal) => {
        if (handle.child && typeof handle.child.kill === "function") {
          try {
            handle.child.kill(signal);
            return true;
          } catch (_) {
            return false;
          }
        }
        if (pid) return killPid(pid, signal);
        return false;
      },
    };

    entries.push(entry);
    return handle;
  }

  function trackPid(name, pid, trackOptions = {}) {
    if (!pid) return null;
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) return null;
    if (trackedPids.has(numericPid)) return numericPid;
    trackedPids.add(numericPid);

    const entry = {
      name: name || "pid",
      pid: numericPid,
      stop: (reason) => {
        if (typeof trackOptions.stop === "function") {
          try {
            trackOptions.stop(reason);
          } catch (_) {
            // ignore cleanup errors
          }
        }
      },
      wait: (timeoutMs) =>
        waitForPidExit(numericPid, timeoutMs, pollIntervalMs),
      forceKill: (signal) => killPid(numericPid, signal),
    };

    entries.push(entry);
    return numericPid;
  }

  function trackCleanup(name, cleanup) {
    if (typeof cleanup !== "function") return null;
    const entry = {
      name: name || "cleanup",
      stop: () => {
        try {
          cleanup();
        } catch (_) {
          // ignore cleanup errors
        }
      },
      wait: () => Promise.resolve(true),
      forceKill: () => false,
    };
    entries.push(entry);
    return cleanup;
  }

  async function shutdown(reason, shutdownOptions = {}) {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      const snapshot = entries.slice();
      if (!snapshot.length) return;

      const graceMs = Number.isFinite(Number(shutdownOptions.graceMs))
        ? Number(shutdownOptions.graceMs)
        : defaultGraceMs;
      const waitMs = Number.isFinite(Number(shutdownOptions.waitMs))
        ? Number(shutdownOptions.waitMs)
        : defaultWaitMs;
      const forceWaitMs = Number.isFinite(Number(shutdownOptions.forceWaitMs))
        ? Number(shutdownOptions.forceWaitMs)
        : defaultForceWaitMs;
      const forceSignal =
        shutdownOptions.forceSignal || defaultForceSignal || DEFAULT_FORCE_SIGNAL;

      if (log?.info) {
        log.info(
          `[${label}] shutdown starting entries=${snapshot.length} reason=${reason || "n/a"}`
        );
      }

      const stopResults = await Promise.allSettled(
        snapshot.map((entry) => {
          try {
            return entry.stop ? entry.stop(reason) : null;
          } catch (_) {
            return null;
          }
        })
      );

      if (log?.debug) {
        const failures = stopResults.filter((r) => r.status === "rejected")
          .length;
        if (failures) {
          log.debug(`[${label}] shutdown stop errors=${failures}`);
        }
      }

      const waitResults = await Promise.allSettled(
        snapshot.map((entry) => (entry.wait ? entry.wait(waitMs) : true))
      );

      const pending = [];
      for (let i = 0; i < snapshot.length; i += 1) {
        const res = waitResults[i];
        const ok = res && res.status === "fulfilled" && res.value === true;
        if (!ok) pending.push(snapshot[i]);
      }

      if (pending.length) {
        if (log?.warn) {
          log.warn(
            `[${label}] shutdown forcing ${pending.length} lingering workers`
          );
        }
        pending.forEach((entry) => {
          try {
            entry.forceKill?.(forceSignal);
          } catch (_) {
            // ignore kill failures
          }
        });

        await Promise.allSettled(
          pending.map((entry) =>
            entry.wait ? entry.wait(forceWaitMs) : true
          )
        );
      }
    })();

    return shutdownPromise;
  }

  return {
    trackWorker,
    trackPid,
    trackCleanup,
    shutdown,
  };
}

module.exports = {
  createShutdownCoordinator,
};
