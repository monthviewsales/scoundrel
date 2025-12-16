'use strict';

const fs = require('fs');

const path = require('path');

/**
 * Scoundrel JSON artifact layout (disk outputs only)
 *
 * Root directory
 *   - SC_DATA_DIR controls the root. If not set, defaults to "<cwd>/data".
 *   - SC_DATA_DIR may be absolute (e.g., "/data") or relative (e.g., "data").
 *
 * Command namespaces
 *   - autopsy:  <root>/autopsy/<wallet>/<mint>/
 *   - dossier:  <root>/dossier/<traderAlias>/
 *
 * Stages (subdirectories)
 *   - raw:      untouched API responses
 *   - prompt:   enriched payload sent to the AI model
 *   - response: model response payload
 *
 * Naming convention
 *   - <prefix>-<runId>.json
 *     Example: tokenInfo-2025-12-15T14-48-43-890Z.json
 *
 * Save flags (control disk writes only; DB persistence is always on)
 *   - SAVE_RAW
 *   - SAVE_PROMPT
 *   - SAVE_RESPONSE
 *   - NODE_ENV=development enables all three regardless of flags.
 */

function toBoolEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

/**
 * Shared view of artifact save flags.
 *
 * New standard (disk JSON outputs only):
 *   - SAVE_RAW: save untouched API responses
 *   - SAVE_PROMPT: save the enriched prompt payload sent to the AI
 *   - SAVE_RESPONSE: save the AI response payload
 *
 * Back-compat (deprecated):
 *   - SAVE_PARSED behaves like SAVE_PROMPT
 *   - SAVE_ENRICHED / SAVE_ENHANCED behaves like SAVE_PROMPT + SAVE_RESPONSE
 *
 * NODE_ENV=development is a full override and enables all saves.
 *
 * @returns {{ saveRaw: boolean, savePrompt: boolean, saveResponse: boolean, env: string, legacy: { saveParsed: boolean, saveEnriched: boolean, saveEnhanced: boolean } }}
 */
function getArtifactConfig() {
  const env = process.env.NODE_ENV || 'development';
  const isDevOverride = String(env).toLowerCase() === 'development';

  // Legacy flags (deprecated but still supported)
  const legacySaveParsed = toBoolEnv(process.env.SAVE_PARSED);
  const legacySaveEnriched = toBoolEnv(process.env.SAVE_ENRICHED || process.env.SAVE_ENHANCED);

  // New standard flags
  const saveRaw = isDevOverride || toBoolEnv(process.env.SAVE_RAW);

  // SAVE_PROMPT can be explicitly enabled, or implied by legacy SAVE_PARSED / SAVE_ENRICHED.
  const savePrompt =
    isDevOverride ||
    toBoolEnv(process.env.SAVE_PROMPT) ||
    legacySaveParsed ||
    legacySaveEnriched;

  // SAVE_RESPONSE can be explicitly enabled, or implied by legacy SAVE_ENRICHED.
  const saveResponse = isDevOverride || toBoolEnv(process.env.SAVE_RESPONSE) || legacySaveEnriched;

  return {
    saveRaw,
    savePrompt,
    saveResponse,
    env,
    legacy: {
      saveParsed: legacySaveParsed,
      saveEnriched: legacySaveEnriched,
      saveEnhanced: legacySaveEnriched,
    },
  };
}

/**
 * Create a scoped artifact writer for a single command run.
 *
 * @param {Object} params
 * @param {string} params.command               - Command namespace (e.g., 'autopsy', 'dossier')
 * @param {string[]} [params.segments=[]]       - Additional path segments under the command (wallet/mint, alias, etc.)
 * @param {string} [params.runId]               - Run identifier used for filenames (defaults to formatRunId())
 * @param {Object} [params.logger]              - Optional logger with info/warn methods
 * @returns {{ baseDir: string, runId: string, write: Function, loadLatest: Function }}
 */
function createArtifactWriter({ command, segments = [], runId, logger } = {}) {
  if (!command) {
    throw new Error('[jsonArtifacts] createArtifactWriter requires `command`');
  }

  const resolvedRunId = runId || formatRunId();
  const safeCommand = sanitizeSegment(command, 'command');
  const safeSegments = (Array.isArray(segments) ? segments : [segments])
    .filter(Boolean)
    .map((s) => sanitizeSegment(String(s), 'segment'));

  const baseDir = path.join(getDataRootDir(), safeCommand, ...safeSegments);

  function isStageEnabled(stage) {
    const { saveRaw, savePrompt, saveResponse } = getArtifactConfig();
    if (stage === 'raw') return !!saveRaw;
    if (stage === 'prompt') return !!savePrompt;
    if (stage === 'response') return !!saveResponse;
    return false;
  }

  function normalizeStage(stage) {
    const s = String(stage || '').trim().toLowerCase();
    if (s === 'raw' || s === 'prompt' || s === 'response') return s;
    throw new Error(`[jsonArtifacts] invalid artifact stage: ${stage}`);
  }

  /**
   * Write an artifact for a given stage.
   *
   * @param {'raw'|'prompt'|'response'} stage
   * @param {string} prefix
   * @param {any} data
   * @returns {string|null} path written, or null if skipped by flags
   */
  function write(stage, prefix, data) {
    const normalizedStage = normalizeStage(stage);
    if (!isStageEnabled(normalizedStage)) return null;

    const safePrefix = sanitizeSegment(prefix, 'artifact');
    const filename = `${safePrefix}-${resolvedRunId}.json`;

    const fullPath = writeJsonArtifact(baseDir, [normalizedStage], filename, data);
    if (process.env.NODE_ENV === 'development') {
      logger?.info?.(`[jsonArtifacts] wrote ${normalizedStage} → ${fullPath}`);
    }
    return fullPath;
  }

  /**
   * Load the latest artifact for a given stage/prefix.
   *
   * @param {'raw'|'prompt'|'response'} stage
   * @param {string} prefix
   * @returns {{ path: string, data: any }|null}
   */
  function loadLatest(stage, prefix) {
    const normalizedStage = normalizeStage(stage);
    const safePrefix = sanitizeSegment(prefix, 'artifact');
    return loadLatestJson(baseDir, [normalizedStage], `${safePrefix}-`);
  }

  return {
    baseDir,
    runId: resolvedRunId,
    write,
    loadLatest,
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
 * BigInt-safe JSON stringify for artifacts.
 * @param {any} data
 * @returns {string}
 */
function stringifyArtifact(data) {
  return JSON.stringify(
    data,
    (key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
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
  fs.writeFileSync(fullPath, stringifyArtifact(data));
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
 * Resolve the root directory used for JSON artifacts.
 * @returns {string}
 */
function getDataRootDir() {
  const configured = process.env.SC_DATA_DIR;
  if (!configured) return path.join(process.cwd(), 'data');
  const trimmed = String(configured).trim();
  if (!trimmed) return path.join(process.cwd(), 'data');
  return path.isAbsolute(trimmed) ? trimmed : path.join(process.cwd(), trimmed);
}

/**
 * Base directory for dossier artifacts grouped by trader alias.
 * @param {string} traderAlias
 * @returns {string}
 */
function dossierBaseDir(traderAlias) {
  return path.join(getDataRootDir(), 'dossier', sanitizeSegment(traderAlias, 'wallet'));
}

/**
 * Base directory for autopsy artifacts grouped by wallet and mint.
 * @param {string} wallet
 * @param {string} mint
 * @returns {string}
 */
function autopsyBaseDir(wallet, mint) {
  return path.join(
    getDataRootDir(),
    'autopsy',
    sanitizeSegment(wallet, 'wallet'),
    sanitizeSegment(mint, 'mint'),
  );
}

module.exports = {
  autopsyBaseDir,
  dossierBaseDir,
  getDataRootDir,
  formatRunId,
  getArtifactConfig,
  normalizeTraderAlias,
  loadLatestJson,
  readJsonArtifact,
  removeArtifacts,
  sanitizeSegment,
  stringifyArtifact,
  writeJsonArtifact,
  createArtifactWriter,
};
