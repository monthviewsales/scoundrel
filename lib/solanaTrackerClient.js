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
  '@solana-tracker/data-api', // official package name
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
  const names = sdkCandidates.join(' | ');
  throw new Error(`[SolanaTrackerClient] Could not load Data API SDK. Try: npm i @solana-tracker/data-api  (or one of: ${names})`);
}

// Try to import error classes if available (either exported on the module or as named exports)
let DataApiError, RateLimitError, ValidationError;
try {
  DataApiError = DataApiSdk.DataApiError || DataApiSdk?.errors?.DataApiError;
  RateLimitError = DataApiSdk.RateLimitError || DataApiSdk?.errors?.RateLimitError;
  ValidationError = DataApiSdk.ValidationError || DataApiSdk?.errors?.ValidationError;
  if (!DataApiError || !RateLimitError || !ValidationError) {
    ({ DataApiError, RateLimitError, ValidationError } = require(resolvedImport));
  }
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
log('info', 'using SDK import', { resolvedImportName: resolvedImport });

// Basic logger
function log(level, msg, meta) {
  const ts = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : '';
  // eslint-disable-next-line no-console
  console[level](`[scoundrel][SolanaTrackerClient][${level.toUpperCase()}] ${ts} ${msg}${payload}`);
}

function looksLikeNetworkError(err) {
  const msg = (err && err.message) ? String(err.message) : '';
  return msg.includes('fetch failed') || msg.includes('getaddrinfo ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('socket hang up');
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
    if (!apiKey) throw new Error('[SolanaTrackerClient] Missing SOLANATRACKER_APIKEY');

    // First attempt: honor provided baseUrl if present
    const tryInit = (opts, label) => {
      try {
        return new SdkClientCtor(opts);
      } catch (e) {
        // Some SDKs use tuple constructor
        try {
          if (opts && opts.baseUrl) return new SdkClientCtor(opts.baseUrl, opts.apiKey);
        } catch (_) {}
        throw e;
      }
    };

    let client, usingUrl = baseUrl || '(sdk default)';
    try {
      client = tryInit(baseUrl ? { baseUrl, apiKey } : { apiKey }, baseUrl ? 'with-baseUrl' : 'default');
    } catch (e) {
      // If this was a network-style failure and we had a baseUrl, retry with SDK defaults
      if (baseUrl && looksLikeNetworkError(e)) {
        log('warn', 'SDK init failed with custom baseUrl; retrying with SDK defaults', { baseUrl });
        client = tryInit({ apiKey }, 'fallback-default');
        usingUrl = '(sdk default)';
      } else {
        throw new Error(`[SolanaTrackerClient] Failed to initialize SDK (${resolvedImport}): ${e?.message}`);
      }
    }

    this.client = client;
    this.baseUrl = usingUrl;
    this.apiKey = apiKey;
    log('info', 'initialized SolanaTracker Data API SDK', { baseUrl: this.baseUrl, using: resolvedImport });
  }

  // ---- High-level methods ----

  /**
   * Fetch trades for a wallet, newest → oldest, with optional cursor pagination.
   * @param {{wallet: string, limit?: number, parseJupiter?: boolean, hideArb?: boolean, showMeta?: boolean}} params
   * @returns {Promise<Array>} trades
   */
  async getWalletTrades({ wallet, limit = 500, parseJupiter = true, hideArb = true, showMeta = false } = {}) {
    if (!wallet) throw new Error('[SolanaTrackerClient.getWalletTrades] wallet is required');
    const ctx = { op: 'getWalletTrades', wallet, limit, parseJupiter, hideArb, showMeta };

    let all = [];
    let cursor = undefined;

    const run = async () => {
      // SDK signature: getWalletTrades(owner, cursor?, parseJupiter?, hideArb?, showMeta?)
      return this.client.getWalletTrades(wallet, cursor, parseJupiter, hideArb, showMeta);
    };

    while (all.length < limit) {
      log('info', 'fetching wallet trades', { ...ctx, cursor });
      const page = await withRetries(run, { ctx });
      // Expected shape from docs: { trades: [...], nextCursor, hasNextPage }
      const pageTrades = Array.isArray(page?.trades) ? page.trades : (Array.isArray(page) ? page : []);
      all.push(...pageTrades);
      log('info', 'received wallet trades page', { pageCount: pageTrades.length, total: all.length });

      if (!page?.hasNextPage || !page?.nextCursor) break;
      cursor = page.nextCursor;
    }

    if (all.length > limit) all = all.slice(0, limit);
    return all;
  }

  /**
   * Compose a lightweight “snapshot at time T” using price-at-timestamp + token info.
   * @param {{mint: string, ts: number}} params
   */
  async getTokenSnapshotAt({ mint, ts }) {
    if (!mint || !ts) throw new Error('[SolanaTrackerClient.getTokenSnapshotAt] mint and ts are required');
    const ctx = { op: 'getTokenSnapshotAt', mint, ts };

    const runPrice = async () => this.client.getPriceAtTimestamp(mint, ts);
    const runInfo = async () => this.client.getTokenInfo(mint);

    log('info', 'fetching price at timestamp', ctx);
    const priceAt = await withRetries(runPrice, { ctx });

    log('info', 'fetching token info (static)', ctx);
    const info = await withRetries(runInfo, { ctx });

    return {
      token: info?.token || null,
      pools: info?.pools || [],
      priceAt: {
        usd: priceAt?.price ?? priceAt?.priceUsd ?? null,
        time: ts
      }
    };
  }

  /**
   * Get current token info (includes pools, risk, events summary, etc.).
   * @param {{mint: string}} params
   */
  async getTokenSnapshotNow({ mint }) {
    if (!mint) throw new Error('[SolanaTrackerClient.getTokenSnapshotNow] mint is required');
    const ctx = { op: 'getTokenSnapshotNow', mint };

    const run = async () => this.client.getTokenInfo(mint);
    log('info', 'fetching current token info', ctx);
    const out = await withRetries(run, { ctx });
    return out || null;
  }
  
  /**
   * Quick health check: attempts a lightweight request to verify connectivity/auth.
   */
  async healthCheck() {
    const ctx = { op: 'healthCheck' };
    const run = async () => {
      if (this.client?.health?.ping) return this.client.health.ping();
      if (this.client?.tokens?.get) return this.client.tokens.get({ mint: 'So11111111111111111111111111111111111111112' });
      if (this.client?.request) return this.client.request('GET', '/health', {});
      return { ok: true };
    };
    try {
      const res = await withRetries(run, { ctx, attempts: 2, baseMs: 100 });
      log('info', 'healthCheck ok');
      return { ok: true, res };
    } catch (err) {
      handleSdkError(err, ctx);
      return { ok: false, error: err?.message || String(err) };
    }
  }
}

module.exports = { SolanaTrackerClient };
