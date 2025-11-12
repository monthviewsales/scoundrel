

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

// Try to load your project's MySQL client. Adjust the require path if needed.
let db = null;
try {
  db = require('../db');              // common location in this repo
} catch (_) {
  try { db = require('../../lib/db'); } catch (_) {}
}

const log = {
  info: (...a) => console.log('[profiles]', ...a),
  warn: (...a) => console.warn('[profiles]', ...a),
  error: (...a) => console.error('[profiles]', ...a),
};

const J = (o) => JSON.stringify(o == null ? null : o);
const nowIso = () => new Date().toISOString();

function assertDb() {
  if (!db || typeof db.query !== 'function') {
    log.warn('DB client not available; skipping persistence');
    return false;
  }
  return true;
}

/**
 * Fetch the latest version number for a wallet (0 if none).
 * @param {string} wallet
 * @returns {Promise<number>}
 */
async function getLatestVersion(wallet) {
  if (!assertDb()) return 0;
  const sql = 'SELECT version FROM sc_wallet_profiles WHERE wallet = ? LIMIT 1';
  const rows = await db.query(sql, [wallet]);
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
  const updatedAt = nowIso();
  if (!assertDb()) return { wallet, version: 0 };

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
  await db.query(upsertProfiles, [wallet, version, tJson, oJson, hJson, eJson, updatedAt]);
  await db.query(insertVersion,   [wallet, version, tJson, oJson, hJson, eJson, updatedAt]);
  await db.query(upsertIndex,     [wallet, style, entryTech, winRate, medExitPct, medHoldMin, updatedAt]);

  log.info('persisted profile', { wallet, version });
  return { wallet, version };
}

module.exports = {
  persistProfileArtifacts,
  getLatestVersion,
};