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

  fs.writeFileSync(target, JSON.stringify(events, null, 2), 'utf8');
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
    if (Array.isArray(events)) {
      events.forEach((ev) => emitter.emit('event', ev));
      emitter.emit('events', events);
    }
  }

  function watchFile(targetPath, handler) {
    try {
      const watcher = fs.watch(path.dirname(targetPath), { persistent: false }, () => handler());
      watchers.add(watcher);
    } catch (err) {
      // fs.watch can fail on some platforms; fall back to a timer.
      const timer = setInterval(handler, 500);
      watchers.add({ close: () => clearInterval(timer) });
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
