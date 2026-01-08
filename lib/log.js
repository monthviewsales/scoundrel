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

/**
 * Log debug output in development environments.
 *
 * @param {...unknown} args
 * @returns {void}
 */
function debug(...args) {
  if (!isDev) return;
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
  infoWriter(...args);
}

/**
 * Log warnings in all environments (when console is available).
 *
 * @param {...unknown} args
 * @returns {void}
 */
function warn(...args) {
  warnWriter(...args);
}

/**
 * Log errors in all environments (when console is available).
 *
 * @param {...unknown} args
 * @returns {void}
 */
function error(...args) {
  errorWriter(...args);
}

module.exports = {
  debug,
  info,
  warn,
  error,
};
