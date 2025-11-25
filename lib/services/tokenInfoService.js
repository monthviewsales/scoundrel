'use strict';

const BootyBox = require('../../packages/bootybox');
const log = require('../log');

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
 * @param {{ mint: string, client: import('@solana-tracker/data-api').Client }} params
 * @returns {Promise<object|null>} tokenInfo-like object (API response), or null if unavailable.
 */
async function ensureTokenInfo({ mint, client }) {
  if (!mint || typeof mint !== 'string') {
    throw new Error('[tokenInfoService.ensureTokenInfo] mint is required');
  }
  if (!client || typeof client.getTokenInformation !== 'function') {
    throw new Error('[tokenInfoService.ensureTokenInfo] client with getTokenInformation is required');
  }

  let cached = null;
  try {
    cached = await BootyBox.getCoinByMint(mint);
    if (cached && (cached.symbol || cached.name)) {
      // Treat this as "good enough" metadata and return it immediately.
      return cached;
    }
  } catch (err) {
    log.warn(
      '[tokenInfoService.ensureTokenInfo] coins lookup failed, fetching from API instead',
      err?.message || err,
    );
  }

  // Fetch from SolanaTracker
  const info = await client.getTokenInformation(mint);

  // If the response is essentially empty, do NOT overwrite existing DB rows.
  if (!hasRealTokenData(info)) {
    log.warn(
      '[tokenInfoService.ensureTokenInfo] tokenInfo API returned empty/invalid payload; skipping DB update',
      { mint, info: info || null },
    );
    // Prefer returning whatever we had in DB, even if partial.
    return cached || null;
  }

  // Build the payload in the shape BootyBox expects: mint + raw API object.
  // We do NOT normalize or flatten anything here.
  const payload = {
    mint,
    ...info,
  };

  try {
    await BootyBox.addOrUpdateCoin(payload);
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

  // For now, return the API shape (same as before in autopsy).
  return info;
}

module.exports = {
  ensureTokenInfo,
};
