'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DEFAULT_STATUS_PATH = path.join(process.cwd(), 'data', 'warchest', 'status.json');
const DEFAULT_EVENT_PATH = path.join(process.cwd(), 'data', 'warchest', 'tx-events.json');

function resolvePath(targetPath, fallback) {
  if (!targetPath) return fallback;
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function readJson(target, fallback) {
  try {
    const raw = fs.readFileSync(target, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Append a HUD-friendly event to the shared event file.
 *
 * @param {object} event
 * @param {string} [eventPath]
 * @returns {Array}
 */
function appendHubEvent(event, eventPath = DEFAULT_EVENT_PATH) {
  if (!event) return [];
  const target = resolvePath(eventPath, DEFAULT_EVENT_PATH);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const existing = readJson(target, []);
  const events = Array.isArray(existing) ? existing : [];
  events.unshift(event);
  if (events.length > 50) events.length = 50;

  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return events;
}

/**
 * Watch hub status/event files and emit updates.
 *
 * @param {Object} [options]
 * @param {string} [options.statusPath]
 * @param {string} [options.eventPath]
 * @param {boolean} [options.readInitial]
 * @returns {{onStatus:Function,onEvent:Function,onEvents:Function,close:Function,paths:{statusPath:string,eventPath:string}}}
 */
function createHubEventFollower(options = {}) {
  const emitter = new EventEmitter();
  const statusPath = resolvePath(options.statusPath, DEFAULT_STATUS_PATH);
  const eventPath = resolvePath(options.eventPath, DEFAULT_EVENT_PATH);
  const watchers = new Set();
  let closed = false;

  function debounce(fn, ms) {
    let t = null;
    return () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
    };
  }

  function eventKey(ev) {
    if (!ev || typeof ev !== 'object') return '';
    // Prefer txid + observedAt; fall back to a stable-ish composite.
    const txid = ev.txid || ev.txSummary?.txid || '';
    const ts = ev.observedAt || ev.txSummary?.blockTimeIso || '';
    const status = ev.status || ev.txSummary?.status || '';
    const msg = ev.txSummary?.errMessage || ev.txSummary?.label || '';
    return `${txid}|${ts}|${status}|${msg}`;
  }

  const seenEventKeys = new Set();

  function emitStatus() {
    if (closed) return;
    const snapshot = readJson(statusPath, null);
    if (snapshot) {
      emitter.emit('status', snapshot);
    }
  }

  function emitEvents() {
    if (closed) return;
    const events = readJson(eventPath, []);
    if (!Array.isArray(events)) return;

    // File is stored newest-first (appendHubEvent uses unshift). Emit new events oldest->newest.
    const newestFirst = events;
    const oldestFirst = [...newestFirst].reverse();

    for (const ev of oldestFirst) {
      const key = eventKey(ev);
      if (!key) continue;
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.add(key);
      emitter.emit('event', ev);
    }

    // Keep cache bounded (file itself is bounded, but be safe if caller provides a larger file).
    if (seenEventKeys.size > 500) {
      // Rebuild from current file.
      seenEventKeys.clear();
      for (const ev of oldestFirst) {
        const key = eventKey(ev);
        if (key) seenEventKeys.add(key);
      }
    }

    emitter.emit('events', newestFirst);
  }

  function watchFile(targetPath, handler) {
    const run = debounce(handler, 50);
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    let fallbackTimer = null;

    const startFallback = () => {
      if (fallbackTimer) return;
      fallbackTimer = setInterval(run, 500);
      watchers.add({ close: () => clearInterval(fallbackTimer) });
    };

    try {
      const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        // Some platforms don't provide filename; in that case, run best-effort.
        if (!filename) return run();
        // Only react to changes for the target file.
        if (String(filename) === base) return run();
      });
      watchers.add(watcher);
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch (_) {
          // ignore close errors
        }
        watchers.delete(watcher);
        startFallback();
      });
    } catch (err) {
      // fs.watch can fail on some platforms; fall back to a timer.
      startFallback();
    }
  }

  watchFile(statusPath, emitStatus);
  watchFile(eventPath, emitEvents);

  if (options.readInitial !== false) {
    setImmediate(() => emitStatus());
    setImmediate(() => emitEvents());
  }

  function close() {
    if (closed) return;
    closed = true;
    watchers.forEach((w) => {
      try {
        if (w && typeof w.close === 'function') {
          w.close();
        }
      } catch (err) {
        // ignore watcher close errors; follower is best-effort
      }
    });
    watchers.clear();
    emitter.removeAllListeners();
  }

  return {
    onStatus: (fn) => emitter.on('status', fn),
    onEvent: (fn) => emitter.on('event', fn),
    onEvents: (fn) => emitter.on('events', fn),
    close,
    paths: { statusPath, eventPath },
  };
}

module.exports = {
  appendHubEvent,
  createHubEventFollower,
  DEFAULT_EVENT_PATH,
  DEFAULT_STATUS_PATH,
};
