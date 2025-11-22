'use strict';

const fs = require('fs');
const path = require('path');

function toBoolEnv(value) {
  return String(value || '').toLowerCase() === 'true';
}

/**
 * Shared view of artifact save flags.
 * @returns {{ saveRaw: boolean, saveParsed: boolean, saveEnriched: boolean, env: string }}
 */
function getArtifactConfig() {
  return {
    saveRaw: toBoolEnv(process.env.SAVE_RAW),
    saveParsed: toBoolEnv(process.env.SAVE_PARSED),
    saveEnriched: toBoolEnv(process.env.SAVE_ENRICHED),
    env: process.env.NODE_ENV || 'development',
  };
}

/**
 * Normalize a string for use as a path segment.
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeSegment(value, fallback = 'artifact') {
  const cleaned = String(value || fallback)
    .replace(/[^a-z0-9_-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned || fallback;
}

/**
 * Normalize a trader alias consistently for dossier artifacts.
 * @param {string|null|undefined} traderName
 * @param {string} walletId
 * @returns {string}
 */
function normalizeTraderAlias(traderName, walletId) {
  const label = traderName ? String(traderName) : String(walletId || 'wallet');
  const underscored = label.replace(/[^a-z0-9_-]/gi, '_');
  return sanitizeSegment(underscored, 'wallet');
}

/**
 * Standard run identifier used for artifact filenames.
 * @returns {string}
 */
function formatRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write a JSON artifact under the given base and subdirectories.
 * @param {string} baseDir
 * @param {string[]} subdirs
 * @param {string} filename
 * @param {any} data
 * @returns {string} Full path written
 */
function writeJsonArtifact(baseDir, subdirs, filename, data) {
  const dir = path.join(baseDir, ...subdirs);
  ensureDir(dir);
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  return fullPath;
}

/**
 * Read JSON from disk if it exists.
 * @param {string} filePath
 * @returns {any|null}
 */
function readJsonArtifact(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Load the latest JSON artifact in a directory matching a prefix.
 * @param {string} baseDir
 * @param {string[]} subdirs
 * @param {string} prefix
 * @returns {{ path: string, data: any }|null}
 */
function loadLatestJson(baseDir, subdirs, prefix) {
  const dir = path.join(baseDir, ...subdirs);
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  if (!candidates.length) return null;
  const latest = path.join(dir, candidates[candidates.length - 1]);
  return { path: latest, data: readJsonArtifact(latest) };
}

/**
 * Remove one or more artifact files safely.
 * @param {string[]} paths
 */
function removeArtifacts(paths) {
  paths.forEach((p) => {
    if (!p) return;
    try { fs.unlinkSync(p); } catch (_) {}
  });
}

/**
 * Base directory for dossier artifacts grouped by trader alias.
 * @param {string} traderAlias
 * @returns {string}
 */
function dossierBaseDir(traderAlias) {
  return path.join(process.cwd(), 'data', 'dossier', sanitizeSegment(traderAlias, 'wallet'));
}

/**
 * Base directory for autopsy artifacts grouped by wallet and mint.
 * @param {string} wallet
 * @param {string} mint
 * @returns {string}
 */
function autopsyBaseDir(wallet, mint) {
  return path.join(
    process.cwd(),
    'data',
    'autopsy',
    sanitizeSegment(wallet, 'wallet'),
    sanitizeSegment(mint, 'mint'),
  );
}

module.exports = {
  autopsyBaseDir,
  dossierBaseDir,
  formatRunId,
  getArtifactConfig,
  normalizeTraderAlias,
  loadLatestJson,
  readJsonArtifact,
  removeArtifacts,
  sanitizeSegment,
  writeJsonArtifact,
};

