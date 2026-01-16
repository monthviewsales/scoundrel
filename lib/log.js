const ENV = process.env.NODE_ENV || 'development';
const isDev = ENV === 'development';
const safeConsole = typeof console === 'object' && console ? console : {};

const noop = () => {};
const debugWriter =
  typeof safeConsole.debug === 'function' ? safeConsole.debug.bind(safeConsole) : noop;
const infoWriter =
  typeof safeConsole.log === 'function' ? safeConsole.log.bind(safeConsole) : noop;
const warnWriter =
  typeof safeConsole.warn === 'function'
    ? safeConsole.warn.bind(safeConsole)
    : infoWriter;
const errorWriter =
  typeof safeConsole.error === 'function'
    ? safeConsole.error.bind(safeConsole)
    : warnWriter;

function hasArg(flag) {
  return Array.isArray(process.argv) && process.argv.includes(flag);
}

function isInkMode() {
  if (process.env.SC_INK_MODE === '1') return true;
  return hasArg('--ink');
}

function isHudMode() {
  if (process.env.SC_HUD_MODE === '1') return true;
  if (process.env.WARCHEST_HUD === '1') return true;
  return hasArg('--hud');
}

function shouldMuteConsole() {
  const ink = isInkMode();
  const hud = isHudMode();

  if (ink && process.env.SC_INK_ALLOW_CONSOLE === '1') return false;
  if (hud && process.env.SC_HUD_ALLOW_CONSOLE === '1') return false;

  return ink || hud;
}

function forwardToLogger(level, args) {
  try {
    const logger = require('./logger');
    if (logger && typeof logger[level] === 'function') {
      logger[level](...args);
      return true;
    }
  } catch (_) {
    // ignore logger fallback failures
  }
  return false;
}

/**
 * Log debug output in development environments.
 *
 * @param {...unknown} args
 * @returns {void}
 */
function debug(...args) {
  if (!isDev) return;
  if (shouldMuteConsole()) {
    forwardToLogger('debug', args);
    return;
  }
  debugWriter(...args);
}

/**
 * Log info output in development environments.
 *
 * @param {...unknown} args
 * @returns {void}
 */
function info(...args) {
  if (!isDev) return;
  if (shouldMuteConsole()) {
    forwardToLogger('info', args);
    return;
  }
  infoWriter(...args);
}

/**
 * Log warnings in all environments (when console is available).
 *
 * @param {...unknown} args
 * @returns {void}
 */
function warn(...args) {
  if (shouldMuteConsole()) {
    forwardToLogger('warn', args);
    return;
  }
  warnWriter(...args);
}

/**
 * Log errors in all environments (when console is available).
 *
 * @param {...unknown} args
 * @returns {void}
 */
function error(...args) {
  if (shouldMuteConsole()) {
    forwardToLogger('error', args);
    return;
  }
  errorWriter(...args);
}

module.exports = {
  debug,
  info,
  warn,
  error,
};
