'use strict';

const OpenAI = require('openai');
const baseLogger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');

const logger = createWorkerLogger({
  workerName: 'openaiFilePrune',
  scope: 'openaiFilePrune',
  baseLogger,
  includeCallsite: true,
});

/**
 * @typedef {Object} OpenAiFilePrunePayload
 * @property {string|string[]} [prefix]
 * @property {string} [purpose]
 * @property {number} [olderThanSeconds]
 * @property {number} [olderThanHours]
 * @property {boolean} [dryRun]
 * @property {number} [maxDeletes]
 */

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function expandPrefixes(prefixes) {
  const expanded = new Set();
  for (const prefix of prefixes) {
    const normalized = String(prefix || '').trim().toLowerCase();
    if (!normalized) continue;
    expanded.add(normalized);
    if (!normalized.startsWith('warlordai-')) {
      expanded.add(`warlordai-${normalized}`);
    }
  }
  return Array.from(expanded);
}

function normalizePrefixList(prefixes) {
  const raw = [];
  if (Array.isArray(prefixes)) {
    raw.push(...prefixes);
  } else if (typeof prefixes === 'string') {
    prefixes.split(',').forEach((item) => raw.push(item));
  } else if (prefixes != null) {
    raw.push(String(prefixes));
  }

  const normalized = raw
    .map((item) => String(item).trim())
    .filter(Boolean);
  const base = normalized.length ? normalized : ['targetscan'];
  return expandPrefixes(base);
}

function matchesPrefix(value, prefixes) {
  if (!value) return false;
  const candidate = String(value).trim().toLowerCase();
  if (!candidate) return false;
  return prefixes.some((prefix) => candidate.startsWith(prefix));
}

function normalizePurpose(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'all' || lowered === '*') return null;
  return trimmed;
}

function resolveCutoffSec(olderThanSeconds, olderThanHours) {
  const olderThanSecondsNum = toPositiveNumber(olderThanSeconds);
  const olderThanHoursNum = toPositiveNumber(olderThanHours);
  const cutoffMs = Date.now() - (
    olderThanSecondsNum
      ? olderThanSecondsNum * 1000
      : (olderThanHoursNum ? olderThanHoursNum * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
  );
  return Math.floor(cutoffMs / 1000);
}

async function listMatchingFiles({ openai, prefixes, cutoffSec, purpose, maxDeletes }) {
  const matches = [];
  let scanned = 0;
  let oldEnough = 0;
  let matched = 0;
  let skipped = 0;

  const listParams = {
    limit: 10000,
    order: 'desc',
    ...(purpose ? { purpose } : {}),
  };

  for await (const file of openai.files.list(listParams)) {
    scanned += 1;
    const createdAt = Number(file?.created_at ?? 0);
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      skipped += 1;
      continue;
    }
    if (createdAt > cutoffSec) {
      continue;
    }
    oldEnough += 1;

    const fileId = file?.id || null;
    if (!fileId) {
      skipped += 1;
      continue;
    }

    const filename = file?.filename || '';
    if (!matchesPrefix(filename, prefixes)) {
      skipped += 1;
      continue;
    }

    matches.push({ id: fileId, filename, createdAt });
    matched += 1;
    if (maxDeletes && matches.length >= maxDeletes) break;
  }

  return { matches, scanned, oldEnough, matched, skipped };
}

async function pruneOpenAiFiles(payload, tools = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[openaiFilePruneWorker] OPENAI_API_KEY missing; skipping prune');
    return { skipped: true, reason: 'missing_openai_key' };
  }

  const prefixes = normalizePrefixList(payload?.prefix);
  const purpose = normalizePurpose(payload?.purpose);
  const maxDeletesNum = toPositiveNumber(payload?.maxDeletes);
  const cutoffSec = resolveCutoffSec(payload?.olderThanSeconds, payload?.olderThanHours);
  const dryRun = payload?.dryRun === true;
  const openai = new OpenAI({ apiKey });
  const progress = tools && typeof tools.progress === 'function' ? tools.progress : null;

  let deleted = 0;
  let errors = 0;

  const { matches, scanned, oldEnough, matched, skipped } = await listMatchingFiles({
    openai,
    prefixes,
    cutoffSec,
    purpose,
    maxDeletes: maxDeletesNum,
  });

  if (progress) {
    progress('openai-fileprune:found', {
      total: matches.length,
      dryRun,
      current: dryRun ? matches.length : 0,
    });
  }

  if (!dryRun) {
    for (let i = 0; i < matches.length; i += 1) {
      const entry = matches[i];
      const current = i + 1;
      if (progress) {
        progress('openai-fileprune:delete', {
          current,
          total: matches.length,
          fileId: entry.id,
          filename: entry.filename,
          deleted,
          errors,
        });
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await openai.files.delete(entry.id);
        deleted += 1;
      } catch (err) {
        errors += 1;
        logger.warn('[openaiFilePruneWorker] delete failed', {
          fileId: entry.id,
          filename: entry.filename,
          err: err?.message || err,
        });
      }
    }
  }

  const summary = {
    dryRun,
    prefixes,
    purpose: purpose || null,
    cutoffSec,
    scanned,
    oldEnough,
    matched,
    deleted,
    skipped,
    errors,
  };

  logger.info('[openaiFilePruneWorker] prune complete', summary);
  return summary;
}

/**
 * Run the OpenAI file prune worker.
 *
 * @param {OpenAiFilePrunePayload} payload
 * @param {object} [tools]
 * @returns {Promise<object>}
 */
async function runOpenaiFilePruneWorker(payload, tools) {
  const normalized = validateOpenaiFilePrunePayload(payload);
  return pruneOpenAiFiles(normalized, tools);
}

/**
 * Validate and normalize OpenAI file prune payloads.
 *
 * @param {OpenAiFilePrunePayload} payload
 * @returns {OpenAiFilePrunePayload}
 */
function validateOpenaiFilePrunePayload(payload) {
  const out = {};
  if (payload?.prefix != null) out.prefix = payload.prefix;
  if (payload?.purpose != null) out.purpose = String(payload.purpose).trim();
  if (payload?.olderThanSeconds != null) {
    out.olderThanSeconds = Number(payload.olderThanSeconds);
  }
  if (payload?.olderThanHours != null) {
    out.olderThanHours = Number(payload.olderThanHours);
  }
  if (payload?.dryRun != null) out.dryRun = Boolean(payload.dryRun);
  if (payload?.maxDeletes != null) out.maxDeletes = Number(payload.maxDeletes);
  return out;
}

createWorkerHarness(runOpenaiFilePruneWorker, {
  workerName: 'openaiFilePrune',
  logger,
});

module.exports = { runOpenaiFilePruneWorker, validateOpenaiFilePrunePayload };
