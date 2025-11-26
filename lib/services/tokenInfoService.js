'use strict';

const BootyBox = require('../../packages/bootybox');
const log = require('../log');

let bootyboxReadyPromise

/**
 * Initialize BootyBox once so downstream helpers can safely hit the DB.
 * @returns {Promise<boolean>} true when BootyBox is ready, false when unavailable.
 */
async function ensureBootyBoxReady() {
  if (bootyboxReadyPromise) return bootyboxReadyPromise;

  bootyboxReadyPromise = (async () => {
    if (!BootyBox || typeof BootyBox.init !== 'function') {
      log.warn('[tokenInfoService.ensureTokenInfo] BootyBox client unavailable; skipping DB cache');
      return false;
    }

    try {
      await BootyBox.init();
      return true;
    } catch (err) {
      log.warn(
        '[tokenInfoService.ensureTokenInfo] BootyBox init failed; skipping DB cache',
        err?.message || err,
      );
      return false;
    }
  })();

  return bootyboxReadyPromise;
}

/**
 * Local helper to safely parse numeric values.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Determine whether the token info payload from SolanaTracker
 * actually contains meaningful data, or is effectively empty/garbage.
 *
 * We use this to avoid overwriting a good DB row with all nulls
 * when the API is having a bad day.
 *
 * @param {object|null|undefined} info
 * @returns {boolean}
 */
function hasRealTokenData(info) {
  if (!info) return false;

  // SolanaTracker wraps metadata in `token`, but keep backward-compat if that ever changes.
  const token = info.token || info;

  return Boolean(
    token.symbol ||
      token.name ||
      token.decimals != null,
  );
}

/**
 * Ensure we have token metadata for a given mint.
 *
 * This will:
 * 1. Try to return a cached row from BootyBox.coins.
 * 2. If missing or clearly incomplete, fetch from SolanaTracker via the data client.
 * 3. Upsert the coins row when the response contains meaningful data.
 * 4. Never clobber an existing, non-empty row with an "all nulls" payload.
 *
 * @param {{ mint: string, client: import('@solana-tracker/data-api').Client, forceRefresh?: boolean }} params
 * @returns {Promise<object|null>} tokenInfo-like object (API response), or null if unavailable.
 */
async function ensureTokenInfo({ mint, client, forceRefresh = false }) {
  if (!mint || typeof mint !== 'string') {
    throw new Error('[tokenInfoService.ensureTokenInfo] mint is required');
  }
  if (!client || typeof client.getTokenInformation !== 'function') {
    throw new Error('[tokenInfoService.ensureTokenInfo] client with getTokenInformation is required');
  }

  if (forceRefresh) {
    log.info('[tokenInfoService.ensureTokenInfo] forceRefresh=true; skipping cached DB metadata and refetching from API', { mint });
  }

  log.debug('[tokenInfoService.ensureTokenInfo] start', { mint });

  const dbReady = await ensureBootyBoxReady();

  log.debug('[tokenInfoService.ensureTokenInfo] BootyBox ready?', dbReady);

  let cached = null;
  if (dbReady && !forceRefresh) {
    try {
      cached = await BootyBox.getCoinByMint(mint);
      log.debug('[tokenInfoService.ensureTokenInfo] cached coin lookup result', cached);
      if (cached && (cached.symbol || cached.name)) {
        log.info('[tokenInfoService.ensureTokenInfo] cached DB metadata is sufficient; no API fetch needed', {
          mint,
          symbol: cached.symbol,
          name: cached.name,
        });
        return cached;
      }
    } catch (err) {
      log.warn(
        '[tokenInfoService.ensureTokenInfo] coins lookup failed, fetching from API instead',
        err?.message || err,
      );
    }
  }

  log.debug('[tokenInfoService.ensureTokenInfo] fetching token information from SolanaTracker');
  // Fetch from SolanaTracker
  const info = await client.getTokenInformation(mint);
  log.debug('[tokenInfoService.ensureTokenInfo] raw token info from SolanaTracker', info);

  // If the response is essentially empty, do NOT overwrite existing DB rows.
  if (!hasRealTokenData(info)) {
    log.warn(
      '[tokenInfoService.ensureTokenInfo] tokenInfo API returned empty/invalid payload; skipping DB update',
      { mint, info: info || null },
    );
    // Prefer returning whatever we had in DB, even if partial.
    return cached || null;
  }

  // Build the payload in the shape BootyBox expects:
  // mint + full SolanaTracker API payload (token, pools, events, risk, etc.)
  const token = info.token || info || {};
  const payload = {
    mint,
    token,
    pools: Array.isArray(info.pools)
      ? info.pools
      : Array.isArray(token.pools)
        ? token.pools
        : [],
    events: info.events || token.events || null,
    risk: info.risk || token.risk || null,
    buys: info.buys ?? token.buys ?? null,
    sells: info.sells ?? token.sells ?? null,
    txns: info.txns ?? token.txns ?? null,
    holders: info.holders ?? token.holders ?? null,
    // convenience fields for callers expecting top-level metadata
    symbol: token.symbol ?? info.symbol ?? null,
    name: token.name ?? info.name ?? null,
    decimals: token.decimals ?? info.decimals ?? null,
  };
  log.debug('[tokenInfoService.ensureTokenInfo] full payload constructed for BootyBox', payload);

  if (dbReady) {
    try {
      log.debug('[tokenInfoService.ensureTokenInfo] writing payload to BootyBox');
      await BootyBox.addOrUpdateCoin(payload);
      log.debug('[tokenInfoService.ensureTokenInfo] BootyBox write success');
    } catch (err) {
      const missingColumn = err?.code === 'ER_BAD_FIELD_ERROR';
      const context = {
        mint,
        code: err?.code,
        errno: err?.errno,
        sqlState: err?.sqlState,
      };
      if (err?.sqlMessage) context.sqlMessage = err.sqlMessage;
      if (err?.sql) context.sql = err.sql;

      const hint = missingColumn
        ? ' (coins table schema mismatch; run DB migrations)'
        : '';
      log.warn(
        `[tokenInfoService.ensureTokenInfo] failed to persist token info${hint}:`,
        context,
        err?.stack || err?.message || err,
      );
    }
  }

  // For now, return the enriched payload (same as BootyBox saw).
  return payload;
}

module.exports = {
  ensureTokenInfo,
};
