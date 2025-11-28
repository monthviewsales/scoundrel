/**
 * Profile persistence (MySQL)
 * - Append-only history: sc_wallet_profile_versions
 * - Latest snapshot:     sc_wallet_profiles
 * - Query index:         sc_wallet_profile_index
 *
 * This module is intentionally defensive: if the DB client is missing,
 * it will log a warning and no-op (returning a fake version of 0-dev).
 */

const logger = require('../logger');
// Load the project's DB client (BootyBox submodule)
let BootyBox = null;
try {
  BootyBox = require('../../packages/BootyBox');
} catch (e) {
  logger.warn('[profiles] BootyBox module unavailable; persistence disabled', e?.message || e);
}

const log = {
  info: (...a) => logger.log('[profiles]', ...a),
  warn: (...a) => logger.warn('[profiles]', ...a),
  error: (...a) => logger.error('[profiles]', ...a),
};


const mask = (s) => (typeof s === 'string' && s.length > 6) ? s.slice(0, 2) + '***' + s.slice(-2) : s;
const envPresence = () => ({
  DB_HOST: !!process.env.DB_HOST,
  DB_PORT: !!process.env.DB_PORT,
  DB_USER: !!process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD ? '***' : false,
  DB_NAME: !!process.env.DB_NAME,
});

let _dbReady = null; // tri-state: null=unchecked, true=ok, false=bad
async function ensureDb() {
  if (!BootyBox || typeof BootyBox.init !== 'function') {
    log.warn('DB client not available; skipping persistence');
    _dbReady = false;
    return null;
  }
  if (_dbReady === true) return BootyBox;
  try {
    await BootyBox.init();
    _dbReady = true;
    return BootyBox;
  } catch (e) {
    _dbReady = false;
    const envs = envPresence();
    log.warn('DB init failed; skipping persistence', {
      reason: e && e.message ? e.message : String(e),
      env: envs,
      host: process.env.DB_HOST || null,
      name: process.env.DB_NAME || null,
      user: process.env.DB_USER || null,
    });
    return null;
  }
}

/**
 * Fetch the latest version number for a wallet (0 if none).
 * @param {string} wallet
 * @returns {Promise<number>}
 */
async function getLatestVersion(wallet) {
  const dbc = await ensureDb();
  if (!dbc) return 0;
  return dbc.getLatestWalletProfileVersion(wallet);
}

/**
 * Persist a new set of profile artifacts, updating snapshot & appending versioned history.
 * @param {Object} opts
 * @param {string} opts.wallet
 * @param {Object|null} opts.technique
 * @param {Object|null} opts.outcomes
 * @param {Object|null} opts.heuristics
 * @param {Object|null} opts.enrichment
 * @returns {Promise<{ wallet: string, version: number }>}
 */
async function persistProfileArtifacts({ wallet, technique, outcomes, heuristics, enrichment }) {
  if (!wallet) throw new Error('persistProfileArtifacts: wallet is required');
  const dbc = await ensureDb();
  if (!dbc) return { wallet, version: 0 };
  const result = await dbc.persistWalletProfileArtifacts({
    wallet,
    technique,
    outcomes,
    heuristics,
    enrichment,
  });
  log.info('persisted profile', result);
  return result;
}

module.exports = {
  persistProfileArtifacts,
  getLatestVersion,
};
