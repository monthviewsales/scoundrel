// lib/solanaTrackerClient.js
// Wrapper around the SolanaTracker Data API SDK with structured logging and retries.
// Env:
//   SOLANATRACKER_URL    -> base URL of the Data API
//   SOLANATRACKER_APIKEY -> API key for the Data API
//
// Notes:
// - You said we don't have websockets; this uses HTTP only.
// - Import path for the SDK may vary; we try a couple of likely names and
//   throw a helpful error if not found.
// - All functions return plain JS objects as provided by the SDK.

require('dotenv').config();

const BASE_URL = process.env.SOLANATRACKER_URL;
const API_KEY = process.env.SOLANATRACKER_APIKEY;

let DataApiSdk;
let resolvedImport = null;
const sdkCandidates = [
  'solanatracker-data-api-sdk',
  '@solanatracker/data-api-sdk',
  'solanatracker-data-api',
];

for (const mod of sdkCandidates) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    DataApiSdk = require(mod);
    resolvedImport = mod;
    break;
  } catch (_) { /* try next */ }
}

if (!DataApiSdk) {
  // Provide a clear message to install the right package.
  const names = sdkCandidates.join(' | ');
  throw new Error(`[SolanaTrackerClient] Could not load Data API SDK. Install one of: ${names}`);
}

// Try to import error classes if available
let DataApiError, RateLimitError, ValidationError;
try {
  ({ DataApiError, RateLimitError, ValidationError } = require(resolvedImport));
} catch (_) {
  // ignore if not available
}

function handleSdkError(err, ctx = {}) {
  if (RateLimitError && err instanceof RateLimitError) {
    log('error', 'Rate limit exceeded', { retryAfter: err.retryAfter, ...ctx });
  } else if (ValidationError && err instanceof ValidationError) {
    log('error', 'Validation error', { message: err.message, ...ctx });
  } else if (DataApiError && err instanceof DataApiError) {
    log('error', 'API error', { message: err.message, status: err.status, details: err.details || null, ...ctx });
  } else {
    log('error', 'Unexpected error', { message: err.message, stack: err.stack, ...ctx });
  }
  return err;
}

// SDK shape flexibility: some packages default-export a client class, others export { Client }.
const SdkClientCtor = DataApiSdk.Client || DataApiSdk.default || DataApiSdk;

// Basic logger
function log(level, msg, meta) {
  const ts = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : '';
  // eslint-disable-next-line no-console
  console[level](`[scoundrel][SolanaTrackerClient][${level.toUpperCase()}] ${ts} ${msg}${payload}`);
}

// Retry helper with exponential backoff
async function withRetries(fn, { attempts = 3, baseMs = 250, ctx = {} } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const tryNo = i + 1;
    try {
      if (tryNo > 1) {
        log('warn', `retrying request (attempt ${tryNo}/${attempts})`, ctx);
      }
      // eslint-disable-next-line no-await-in-loop
      const res = await fn();
      return res;
    } catch (err) {
      lastErr = err;
      handleSdkError(err, ctx);
      const status = err?.status || err?.response?.status;
      const code = err?.code || err?.response?.data?.code;
      const details = {
        tryNo,
        attempts,
        status,
        code,
        message: err?.message,
        ctx,
      };
      if (status === 429 || code === 'RATE_LIMITED' || code === 'TooManyRequests' || (RateLimitError && err instanceof RateLimitError)) {
        // Prefer server-provided retryAfter (seconds) when available
        const retryAfterSec = (RateLimitError && err instanceof RateLimitError && typeof err.retryAfter === 'number') ? err.retryAfter : null;
        const sleep = retryAfterSec != null ? Math.max(0, retryAfterSec * 1000) : baseMs * (2 ** i);
        const logMeta = { ...details };
        if (retryAfterSec != null) logMeta.retryAfterSec = retryAfterSec;
        log('warn', `rate-limited by SolanaTracker, backing off ${sleep}ms${retryAfterSec != null ? ' (server hint)' : ''}`, logMeta);
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, sleep));
        continue;
      }
      if (i < attempts - 1) {
        const sleep = baseMs * (2 ** i);
        log('warn', `request failed, backing off ${sleep}ms`, details);
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, sleep));
      }
    }
  }
  // Exhausted retries
  throw lastErr;
}

class SolanaTrackerClient {
  constructor({ baseUrl = BASE_URL, apiKey = API_KEY } = {}) {
    if (!baseUrl) throw new Error('[SolanaTrackerClient] Missing SOLANATRACKER_URL');
    if (!apiKey) throw new Error('[SolanaTrackerClient] Missing SOLANATRACKER_APIKEY');

    // Some SDKs take (baseUrl, apiKey); others (options)
    try {
      this.client = new SdkClientCtor({ baseUrl, apiKey });
    } catch (e) {
      // Fallback constructor shapes
      try {
        this.client = new SdkClientCtor(baseUrl, apiKey);
      } catch (e2) {
        throw new Error(`[SolanaTrackerClient] Failed to initialize SDK (${resolvedImport}). Tried option+tuple constructors. Root: ${e2?.message || e?.message}`);
      }
    }

    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    log('info', 'initialized SolanaTracker Data API SDK', { baseUrl: this.baseUrl, using: resolvedImport });
  }

  // ---- High-level methods ----

  /**
   * Fetch trades/fills for a wallet over an optional time range.
   * @param {{wallet: string, startTime?: number, endTime?: number, limit?: number}} params
   * @returns {Promise<Array>} trades
   */
  async getWalletTrades({ wallet, startTime, endTime, limit = 500 } = {}) {
    if (!wallet) throw new Error('[SolanaTrackerClient.getWalletTrades] wallet is required');
    const ctx = { op: 'getWalletTrades', wallet, startTime, endTime, limit };

    const run = async () => {
      // The exact SDK method may differ; adapt as needed.
      // Common patterns: client.trades.getForWallet(...) OR client.wallet.getTrades(...)
      if (this.client?.trades?.getForWallet) {
        return this.client.trades.getForWallet({ wallet, startTime, endTime, limit });
      }
      if (this.client?.wallet?.getTrades) {
        return this.client.wallet.getTrades({ wallet, startTime, endTime, limit });
      }
      // Fallback: generic request if SDK exposes a low-level get method
      if (this.client?.request) {
        return this.client.request('GET', '/trades/wallet', { wallet, startTime, endTime, limit });
      }
      throw new Error('SDK method for wallet trades not found');
    };

    log('info', 'fetching wallet trades', ctx);
    const out = await withRetries(run, { ctx });
    log('info', 'received wallet trades', { count: Array.isArray(out) ? out.length : (out?.items?.length || 0) });
    return Array.isArray(out) ? out : out?.items || [];
  }

  /**
   * Get a token snapshot at or just before a timestamp (seconds).
   * @param {{mint: string, ts: number}} params
   */
  async getTokenSnapshotAt({ mint, ts }) {
    if (!mint || !ts) throw new Error('[SolanaTrackerClient.getTokenSnapshotAt] mint and ts are required');
    const ctx = { op: 'getTokenSnapshotAt', mint, ts };

    const run = async () => {
      if (this.client?.tokens?.historyAt) {
        return this.client.tokens.historyAt({ mint, ts });
      }
      if (this.client?.token?.historyAt) {
        return this.client.token.historyAt({ mint, ts });
      }
      if (this.client?.tokens?.getHistory) {
        // If returns an array, find the nearest <= ts
        const series = await this.client.tokens.getHistory({ mint, to: ts, limit: 1, order: 'desc' });
        return Array.isArray(series) ? series[0] : series?.items?.[0] || null;
      }
      if (this.client?.request) {
        return this.client.request('GET', '/tokens/history/at', { mint, ts });
      }
      throw new Error('SDK method for token snapshot at ts not found');
    };

    log('info', 'fetching token snapshot @ts', ctx);
    const snap = await withRetries(run, { ctx });
    if (!snap) log('warn', 'no snapshot returned', ctx);
    return snap || null;
  }

  /**
   * Get a live/most recent token snapshot.
   * @param {{mint: string}} params
   */
  async getTokenSnapshotNow({ mint }) {
    if (!mint) throw new Error('[SolanaTrackerClient.getTokenSnapshotNow] mint is required');
    const ctx = { op: 'getTokenSnapshotNow', mint };

    const run = async () => {
      if (this.client?.tokens?.get) {
        return this.client.tokens.get({ mint });
      }
      if (this.client?.token?.get) {
        return this.client.token.get({ mint });
      }
      if (this.client?.request) {
        return this.client.request('GET', '/tokens', { mint });
      }
      throw new Error('SDK method for token current snapshot not found');
    };

    log('info', 'fetching current token snapshot', ctx);
    const snap = await withRetries(run, { ctx });
    if (!snap) log('warn', 'no current snapshot returned', ctx);
    return snap || null;
  }
}

module.exports = { SolanaTrackerClient };
