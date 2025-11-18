'use strict';

const { Client, DataApiError, RateLimitError, ValidationError } = require('@solana-tracker/data-api');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const NETWORK_ERROR_RE = /(ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ECONNABORTED|ETIMEDOUT|socket hang up|fetch failed)/i;
const DEFAULT_ATTEMPTS = Number(process.env.SOLANATRACKER_DATA_MAX_ATTEMPTS || 3);
const DEFAULT_BASE_DELAY_MS = Number(process.env.SOLANATRACKER_DATA_RETRY_BASE_MS || 250);

function stringifyMeta(meta) {
  if (!meta) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (_) {
    return '';
  }
}

function createLogger() {
  const envLevel = (process.env.SOLANATRACKER_DATA_LOG_LEVEL || process.env.LOG_LEVEL || '').toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  const defaultLevel = nodeEnv === 'production' ? 'info' : 'debug';
  const minLevel = LEVELS[envLevel] != null ? LEVELS[envLevel] : LEVELS[defaultLevel];

  function emit(level, message, meta) {
    if ((LEVELS[level] ?? LEVELS.info) > minLevel) return;
    const ts = new Date().toISOString();
    const suffix = stringifyMeta(meta);
    const fn = console[level] || console.log; // eslint-disable-line no-console
    fn(`[scoundrel][DataClient][${level.toUpperCase()}] ${ts} ${message}${suffix}`);
  }

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

function isNetworkError(error) {
  const message = error?.message || '';
  return NETWORK_ERROR_RE.test(String(message));
}

function shouldRetry(error) {
  if (!error) return false;
  if (error instanceof RateLimitError) return true;
  if (error instanceof DataApiError) {
    if (error.status && error.status >= 500) return true;
  }
  if (isNetworkError(error)) return true;
  return false;
}

function computeDelayMs(error, attemptIndex, baseDelayMs) {
  if (error && typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter)) {
    return Math.max(0, error.retryAfter * 1000);
  }
  return baseDelayMs * (2 ** attemptIndex);
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function attachContext(opName, error) {
  if (!error) return new Error(`[SolanaTrackerData.${opName}] Unknown error`);
  if (error instanceof DataApiError || error instanceof ValidationError) {
    if (!error.operation) error.operation = opName; // eslint-disable-line no-param-reassign
    if (typeof error.message === 'string' && !error.message.startsWith('[SolanaTrackerData.')) {
      // eslint-disable-next-line no-param-reassign
      error.message = `[SolanaTrackerData.${opName}] ${error.message}`;
    }
    return error;
  }
  const wrapped = new Error(`[SolanaTrackerData.${opName}] ${error.message || error}`);
  wrapped.cause = error;
  wrapped.operation = opName;
  return wrapped;
}

function createCallWithRetry({ log, attempts = DEFAULT_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS }) {
  const maxAttempts = Math.max(1, attempts);

  return async function call(opName, exec, opts = {}) {
    const localAttempts = Math.max(1, opts.attempts || maxAttempts);
    let lastError;
    for (let attemptIndex = 0; attemptIndex < localAttempts; attemptIndex += 1) {
      const attemptNo = attemptIndex + 1;
      try {
        log.debug('data api call', { op: opName, attempt: attemptNo });
        // eslint-disable-next-line no-await-in-loop
        const result = await exec();
        return result;
      } catch (error) {
        lastError = error;
        const retryable = attemptIndex < localAttempts - 1 && shouldRetry(error);
        if (!retryable) {
          throw attachContext(opName, error);
        }
        const delayMs = computeDelayMs(error, attemptIndex, baseDelayMs);
        log.warn('data api retry', {
          op: opName,
          attempt: attemptNo,
          delayMs,
          status: error?.status,
          code: error?.code,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(delayMs);
      }
    }
    throw attachContext(opName, lastError);
  };
}

function createDataClientContext({ apiKey, baseUrl, maxAttempts, retryBaseMs } = {}) {
  const derivedApiKey = apiKey
    || process.env.SOLANATRACKER_API_KEY
    || process.env.SOLANATRACKER_APIKEY;
  const derivedBaseUrl = baseUrl
    || process.env.SOLANATRACKER_DATA_BASE_URL
    || process.env.SOLANATRACKER_BASE_URL;

  if (!derivedApiKey) {
    throw new Error('[SolanaTrackerData] Missing SOLANATRACKER_API_KEY');
  }

  const client = new Client({ apiKey: derivedApiKey, baseUrl: derivedBaseUrl });
  const log = createLogger();
  const call = createCallWithRetry({
    log,
    attempts: maxAttempts,
    baseDelayMs: retryBaseMs,
  });

  return { client, call, log };
}

module.exports = {
  createDataClientContext,
  DataApiError,
  RateLimitError,
  ValidationError,
};
