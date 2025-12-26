'use strict';

const BootyBox = require('../../db');
const logger = require('../logger').child({ scope: 'tokenInfoService' });

let bootyboxReadyPromise;

function isHudMode() {
  // Keep this conservative and local to tokenInfoService.
  if (process.env.HUD_MODE === 'true') return true;
  if (process.env.WARCHEST_MODE === 'hud') return true;
  if (process.env.WARCHEST_HUD === 'true') return true;
  if (process.env.SCOUNDREL_HUD === 'true') return true;
  return Array.isArray(process.argv) && process.argv.includes('--hud');
}

// Rate-limit repetitive persist warnings per mint (avoids spamming Ink HUD console).
const persistWarnGate = new Map(); // mint -> lastWarnMs
const PERSIST_WARN_MIN_INTERVAL_MS = 60_000;

// De-dupe concurrent API calls per-mint (no TTL / no staleness).
const inflightTokenInfo = new Map();

function shouldEmitPersistWarn(mint) {
  const key = mint || '__unknown__';
  const now = Date.now();
  const last = persistWarnGate.get(key) || 0;
  if (now - last < PERSIST_WARN_MIN_INTERVAL_MS) return false;
  persistWarnGate.set(key, now);
  return true;
}

async function fetchTokenInformationDeduped({ mint, client }) {
  if (inflightTokenInfo.has(mint)) return inflightTokenInfo.get(mint);

  const p = (async () => {
    try {
      return await client.getTokenInformation(mint);
    } finally {
      inflightTokenInfo.delete(mint);
    }
  })();

  inflightTokenInfo.set(mint, p);
  return p;
}

/**
 * Initialize BootyBox once so downstream helpers can safely hit the DB.
 * @returns {Promise<boolean>} true when BootyBox is ready, false when unavailable.
 */
async function ensureBootyBoxReady() {
  if (bootyboxReadyPromise) return bootyboxReadyPromise;

  bootyboxReadyPromise = (async () => {
    if (!BootyBox || typeof BootyBox.init !== 'function') {
      logger.warn('BootyBox client unavailable; skipping DB cache');
      return false;
    }

    try {
      await BootyBox.init();
      return true;
    } catch (err) {
      logger.warn('BootyBox init failed; skipping DB cache', { err: err?.message || err });
      return false;
    }
  })();

  return bootyboxReadyPromise;
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

function pickMintFromInfo(info) {
  const token = info?.token || info;
  return (
    token?.mint ||
    token?.address ||
    token?.tokenMint ||
    info?.mint ||
    info?.address ||
    null
  );
}

function normalizeTokenInfoPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];

  // Wallet contract: { tokens: [ { token: {...}, buys, sells, ... , balance, value }, ... ] }
  if (Array.isArray(payload.tokens)) {
    return payload.tokens.filter((t) => t && typeof t === 'object');
  }

  // Single-token contract: { token: {...}, buys, sells, ... }
  if (payload.token && typeof payload.token === 'object') {
    return [payload];
  }

  // Backward-compat (if API ever returns token fields top-level)
  if (payload.symbol || payload.name || payload.decimals != null) {
    return [payload];
  }

  return [];
}

function buildCoinUpsertPayload(info, mintOverride) {
  const token = info?.token || info || {};
  const mint = mintOverride || pickMintFromInfo(info) || token?.mint || null;

  return {
    mint,
    status: 'complete',
    token,
    pools: Array.isArray(info?.pools)
      ? info.pools
      : Array.isArray(token?.pools)
        ? token.pools
        : [],
    events: info?.events || token?.events || null,
    risk: info?.risk || token?.risk || null,
    buys: info?.buys ?? token?.buys ?? null,
    sells: info?.sells ?? token?.sells ?? null,
    txns: info?.txns ?? token?.txns ?? null,
    holders: info?.holders ?? token?.holders ?? null,

    // convenience fields for callers expecting top-level metadata
    symbol: token?.symbol ?? info?.symbol ?? null,
    name: token?.name ?? info?.name ?? null,
    decimals: token?.decimals ?? info?.decimals ?? null,
  };
}

async function upsertTokenInfoPayload(payload) {
  const dbReady = await ensureBootyBoxReady();
  if (!dbReady) return { enabled: false, attempted: 0, upserted: 0, skipped: 0, failed: 0 };

  const rows = normalizeTokenInfoPayload(payload);
  let attempted = 0;
  let upserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    attempted += 1;

    const mint = pickMintFromInfo(row);
    if (!mint || typeof mint !== 'string' || !mint.trim()) {
      skipped += 1;
      continue;
    }

    if (!hasRealTokenData(row)) {
      skipped += 1;
      continue;
    }

    const coinPayload = buildCoinUpsertPayload(row, mint);
    try {
      await BootyBox.addOrUpdateCoin(coinPayload);
      upserted += 1;
    } catch (err) {
      failed += 1;
      const missingColumn = err?.code === 'ER_BAD_FIELD_ERROR';
      const context = {
        mint,
        code: err?.code,
        errno: err?.errno,
        sqlState: err?.sqlState,
      };
      if (err?.sqlMessage) context.sqlMessage = err.sqlMessage;
      if (err?.sql) context.sql = err.sql;

      const hint = missingColumn ? ' (coins table schema mismatch; run DB migrations)' : '';

      const payload = {
        ...context,
        err: err?.message || err,
      };

      // In HUD mode, keep the screen clean; details still go to log files.
      const hud = isHudMode();
      const emit = !hud || shouldEmitPersistWarn(mint);
      const logFn = hud ? logger.debug.bind(logger) : logger.warn.bind(logger);

      if (emit) {
        logFn(`Failed to persist token info${hint}`, payload);
      }
    }
  }

  return {
    enabled: true,
    attempted,
    upserted,
    skipped,
    failed,
  };
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

  const dbReady = await ensureBootyBoxReady();

  let cached = null;
  if (dbReady && !forceRefresh) {
    try {
      cached = await BootyBox.getCoinByMint(mint);
      if (cached && (cached.symbol || cached.name)) {
        return cached;
      }
    } catch (err) {
      logger.warn('BootyBox coins lookup failed; falling back to API', { mint, err: err?.message || err });
    }
  }

  // Fetch from SolanaTracker (de-duped across concurrent callers)
  let info;
  try {
    info = await fetchTokenInformationDeduped({ mint, client });
  } catch (err) {
    logger.warn('SolanaTracker getTokenInformation failed; returning cached if available', {
      mint,
      err: err?.message || err,
    });
    return cached || null;
  }

  // If the response is essentially empty, do NOT overwrite existing DB rows.
  if (!hasRealTokenData(info)) {
    logger.warn('SolanaTracker returned empty/invalid tokenInfo; skipping DB update', { mint });
    // Prefer returning whatever we had in DB, even if partial.
    return cached || null;
  }

  // Build the payload in the shape BootyBox expects:
  const payload = buildCoinUpsertPayload(info, mint);

  if (dbReady) {
    // Reuse the shared upsert helper so error handling stays consistent.
    await upsertTokenInfoPayload(payload);
  }

  // For now, return the enriched payload (same as BootyBox saw).
  return payload;
}

module.exports = {
  ensureTokenInfo,
  upsertTokenInfoPayload,
};
