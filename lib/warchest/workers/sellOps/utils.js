'use strict';

/**
 * Redact sensitive fields from an object for safe logging.
 * @param {any} obj
 * @returns {any}
 */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && /(key|secret|token|password|private)/i.test(k)) {
      out[k] = v ? '[redacted]' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  redact,
};
