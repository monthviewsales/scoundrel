/**
 * Profile persistence (MySQL)
 * - Append-only history: sc_wallet_profile_versions
 * - Latest snapshot:     sc_wallet_profiles
 * - Query index:         sc_wallet_profile_index
 *
 * This module is intentionally defensive: if the DB client is missing,
 * it will log a warning and no-op (returning a fake version of 0-dev).
 */

const path = require('path');

// Load the project's MySQL client explicitly
let db = null;
try {
  db = require('../db/mysql');
} catch (e) {
  try { db = require('../../lib/db/mysql'); } catch (_) {}
}

const log = {
  info: (...a) => console.log('[profiles]', ...a),
  warn: (...a) => console.warn('[profiles]', ...a),
  error: (...a) => console.error('[profiles]', ...a),
};

const J = (o) => JSON.stringify(o == null ? null : o);
// MySQL DATETIME requires 'YYYY-MM-DD HH:MM:SS' (no timezone suffix)
const nowSql = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
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
  if (!db || typeof db.query !== 'function' || typeof db.ping !== 'function') {
    log.warn('DB client not available; skipping persistence');
    _dbReady = false;
    return null;
  }
  if (_dbReady === true) return db;
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 2500));
    await Promise.race([db.ping(), timeout]);
    _dbReady = true;
    return db;
  } catch (e) {
    _dbReady = false;
    const envs = envPresence();
    log.warn('DB ping failed; skipping persistence', {
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
  const sql = 'SELECT version FROM sc_wallet_profiles WHERE wallet = ? LIMIT 1';
  const rows = await dbc.query(sql, [wallet]);
  if (!rows || !rows.length) return 0;
  const v = Number(rows[0].version || 0);
  return Number.isFinite(v) ? v : 0;
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
  const updatedAt = nowSql();
  const dbc = await ensureDb();
  if (!dbc) return { wallet, version: 0 };

  // Determine next version
  const latest = await getLatestVersion(wallet);
  const version = latest + 1;

  // Serialize JSON blobs
  const tJson = J(technique);
  const oJson = J(outcomes);
  const hJson = J(heuristics);
  const eJson = J(enrichment);

  // Upsert latest snapshot
  const upsertProfiles = `
    INSERT INTO sc_wallet_profiles
      (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      version = VALUES(version),
      technique_json = VALUES(technique_json),
      outcomes_json  = VALUES(outcomes_json),
      heuristics_json= VALUES(heuristics_json),
      enrichment_json= VALUES(enrichment_json),
      updated_at     = VALUES(updated_at)
  `;

  // Append to versions history
  const insertVersion = `
    INSERT INTO sc_wallet_profile_versions
      (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  // Maintain a small index row for query
  const style      = technique && technique.style || null;
  const entryTech  = technique && technique.entryTechnique || null;
  const winRate    = (outcomes && typeof outcomes.winRate === 'number') ? outcomes.winRate : null;
  const medExitPct = (outcomes && outcomes.medianExitPct != null) ? outcomes.medianExitPct : null;
  const medHoldMin = (outcomes && outcomes.medianHoldMins != null) ? outcomes.medianHoldMins : null;

  const upsertIndex = `
    INSERT INTO sc_wallet_profile_index
      (wallet, style, entry_technique, win_rate, median_exit_pct, median_hold_mins, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      style = VALUES(style),
      entry_technique = VALUES(entry_technique),
      win_rate = VALUES(win_rate),
      median_exit_pct = VALUES(median_exit_pct),
      median_hold_mins = VALUES(median_hold_mins),
      last_seen_at = VALUES(last_seen_at)
  `;

  // Execute writes sequentially (simple & reliable)
  await dbc.query(upsertProfiles, [wallet, version, tJson, oJson, hJson, eJson, updatedAt]);
  await dbc.query(insertVersion,   [wallet, version, tJson, oJson, hJson, eJson, updatedAt]);
  await dbc.query(upsertIndex,     [wallet, style, entryTech, winRate, medExitPct, medHoldMin, updatedAt]);

  log.info('persisted profile', { wallet, version });
  return { wallet, version };
}

module.exports = {
  persistProfileArtifacts,
  getLatestVersion,
};