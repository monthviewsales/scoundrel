'use strict';

const logger = require('../../logger');

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']);

/**
 * Determine whether an error is retryable.
 *
 * @param {Error&{code?:string,status?:number}} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  if (err.status === 429) return true;
  return false;
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry + exponential backoff for transient errors.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Object} [options]
 * @param {number} [options.attempts=3] - Total attempts (including the first).
 * @param {number} [options.baseMs=200] - Initial backoff delay in milliseconds.
 * @param {number} [options.maxMs=2000] - Max delay between attempts.
 * @param {Function} [options.shouldRetry=isRetryableError] - Predicate to decide if an error is retryable.
 * @param {Function} [options.onRetry] - Optional hook invoked with `(err, attempt)` before a retry.
 * @param {Function} [options.delayFn=defaultDelay] - Optional override for sleeping between attempts.
 * @returns {Promise<T>}
 */
async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseMs = 200,
    maxMs = 2000,
    shouldRetry = isRetryableError,
    onRetry,
    delayFn = defaultDelay,
  } = options;

  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = typeof shouldRetry === 'function' ? shouldRetry(err) : false;
      if (!retryable || attempt === attempts) {
        break;
      }

      const delayMs = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const msg = err && err.message ? err.message : err;
      logger.warn(`[retry] transient error (attempt ${attempt}/${attempts}): ${msg}`);
      if (typeof onRetry === 'function') {
        onRetry(err, attempt);
      }
      // eslint-disable-next-line no-await-in-loop
      await delayFn(delayMs);
    }
  }

  const finalErr = lastErr || new Error('Retryable operation failed.');
  const message = finalErr && finalErr.message ? finalErr.message : finalErr;
  throw new Error(`Retry failed after ${attempts} attempts: ${message}`);
}

module.exports = {
  isRetryableError,
  withRetry,
};
