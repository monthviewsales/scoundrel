"use strict";

/**
 * Parse a time interval in ms, allowing "off"/"disabled" toggles.
 *
 * @param {any} value
 * @param {number|null} fallback
 * @returns {number|null}
 */
function parseIntervalMs(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["off", "disabled", "false", "0", "no"].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Parse a number with a fallback when the input is invalid.
 *
 * @param {any} value
 * @param {number|null} fallback
 * @returns {number|null}
 */
function parseNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

/**
 * Parse a ratio (supports "5%" or 0.05/5 inputs).
 *
 * @param {any} value
 * @param {number|null} fallback
 * @returns {number|null}
 */
function parseRatio(value, fallback) {
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;

  let ratio = null;
  if (raw.endsWith("%")) {
    const pct = Number.parseFloat(raw.slice(0, -1));
    if (Number.isFinite(pct)) ratio = pct / 100;
  } else {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      ratio = num > 1 && num <= 100 ? num / 100 : num;
    }
  }

  if (!Number.isFinite(ratio) || ratio <= 0) return fallback;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * Normalize a mint string for map lookups.
 *
 * @param {any} mint
 * @returns {string}
 */
function normalizeMint(mint) {
  return mint ? String(mint).trim().toLowerCase() : "";
}

/**
 * Build a noop logger for tests or optional logging.
 *
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/**
 * Normalize a scoped logger: supports factory-style (logger.sellOps()) and object-style (logger.sellOps).
 * Falls back to a noop logger when unavailable.
 *
 * @param {any} logger
 * @param {string} scopeName
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function normalizeScopedLogger(logger, scopeName) {
  if (!logger) return createNoopLogger();
  const scope = scopeName ? String(scopeName) : "";
  try {
    if (scope && typeof logger[scope] === "function") return logger[scope]();
    if (scope && logger[scope]) return logger[scope];
  } catch (_) {
    // ignore
  }
  return logger;
}

module.exports = {
  parseIntervalMs,
  parseNumber,
  parseRatio,
  normalizeMint,
  createNoopLogger,
  normalizeScopedLogger,
};
