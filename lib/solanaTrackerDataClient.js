// lib/SolanaTrackerDataClient.js (simplified)
// Thin wrapper around the official SolanaTracker Data API SDK with basic logging + retries.
// Env:
//   SOLANATRACKER_APIKEY -> API key for the Data API (required)

require('dotenv').config();

const API_KEY = process.env.SOLANATRACKER_APIKEY;

if (!API_KEY) throw new Error('[SolanaTrackerDataClient] Missing SOLANATRACKER_APIKEY');

// Fixed import — no fallbacks, no dynamic resolution
const { Client } = require('@solana-tracker/data-api');

// Basic logger
function log(level, msg, meta) {
  const ts = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : '';
  // eslint-disable-next-line no-console
  console[level](`[scoundrel][SolanaTrackerDataClient][${level.toUpperCase()}] ${ts} ${msg}${payload}`);
}

function isNetworky(err) {
  const m = String(err?.message || '');
  return m.includes('fetch failed') || m.includes('ENOTFOUND') || m.includes('ECONNREFUSED') || m.includes('socket hang up');
}

// Tiny retry helper with exponential backoff + 429 support
async function withRetries(fn, { attempts = 3, baseMs = 250, ctx = {} } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const tryNo = i + 1;
    try {
      if (tryNo > 1) log('warn', `retrying (attempt ${tryNo}/${attempts})`, ctx);
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const retryAfterSec = typeof err?.retryAfter === 'number' ? err.retryAfter : undefined;
      if (status === 429 || retryAfterSec != null || isNetworky(err)) {
        const sleep = retryAfterSec != null ? Math.max(0, retryAfterSec * 1000) : baseMs * (2 ** i);
        log('warn', `backing off ${sleep}ms`, { ...ctx, status, retryAfterSec, message: err?.message });
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, sleep));
        continue;
      }
      if (i < attempts - 1) {
        const sleep = baseMs * (2 ** i);
        log('warn', `retrying after ${sleep}ms`, { ...ctx, status, message: err?.message });
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, sleep));
        continue;
      }
    }
  }
  throw lastErr;
}

class SolanaTrackerDataClient {
  constructor({ baseUrl = BASE_URL, apiKey = API_KEY } = {}) {
    this.client = new Client({ baseUrl, apiKey });
    this.baseUrl = baseUrl || '(sdk default)';
    this.apiKey = apiKey;
    log('info', 'initialized SDK', { baseUrl: this.baseUrl });
  }

  /**
   * Fetch trades for a wallet, newest → oldest, with optional cursor pagination.
   * @param {{wallet: string, limit?: number, parseJupiter?: boolean, hideArb?: boolean, showMeta?: boolean}} params
   * @returns {Promise<Array>} trades
   */
  async getWalletTrades({ wallet, limit = 500, parseJupiter = true, hideArb = true, showMeta = false } = {}) {
    if (!wallet) throw new Error('[SolanaTrackerDataClient.getWalletTrades] wallet is required');
    const ctx = { op: 'getWalletTrades', wallet, limit, parseJupiter, hideArb, showMeta };

    let all = [];
    let cursor; // undefined initially

    const run = () => this.client.getWalletTrades(wallet, cursor, parseJupiter, hideArb, showMeta);

    while (all.length < limit) {
      log('info', 'fetching wallet trades', { ...ctx, cursor });
      // eslint-disable-next-line no-await-in-loop
      const page = await withRetries(run, { ctx });
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
    if (!mint || !ts) throw new Error('[SolanaTrackerDataClient.getTokenSnapshotAt] mint and ts are required');
    const ctx = { op: 'getTokenSnapshotAt', mint, ts };

    const runPrice = () => this.client.getPriceAtTimestamp(mint, ts);
    const runInfo  = () => this.client.getTokenInfo(mint);

    log('info', 'fetching price at timestamp', ctx);
    const priceAt = await withRetries(runPrice, { ctx });

    log('info', 'fetching token info (static)', ctx);
    const info = await withRetries(runInfo, { ctx });

    return {
      token: info?.token || null,
      pools: info?.pools || [],
      priceAt: { usd: priceAt?.price ?? priceAt?.priceUsd ?? null, time: ts }
    };
  }

  /**
   * Get current token info (includes pools, risk, events summary, etc.).
   * @param {{mint: string}} params
   */
  async getTokenSnapshotNow({ mint }) {
    if (!mint) throw new Error('[SolanaTrackerDataClient.getTokenSnapshotNow] mint is required');
    const ctx = { op: 'getTokenSnapshotNow', mint };
    const run = () => this.client.getTokenInfo(mint);
    log('info', 'fetching current token info', ctx);
    return withRetries(run, { ctx });
  }

  /** Quick health check */
  async healthCheck() {
    const ctx = { op: 'healthCheck' };
    try {
      const run = () => (this.client?.health?.ping ? this.client.health.ping() : this.client.getTokenInfo('So11111111111111111111111111111111111111112'));
      const res = await withRetries(run, { ctx, attempts: 2, baseMs: 100 });
      log('info', 'healthCheck ok');
      return { ok: true, res };
    } catch (error) {
      log('error', 'healthCheck failed', { message: error?.message });
      return { ok: false, error: error?.message || String(error) };
    }
  }
}

module.exports = { SolanaTrackerDataClient };
