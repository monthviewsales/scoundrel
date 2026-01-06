'use strict';

/**
 * @deprecated
 * This helper is being phased out in favor of command-specific DB tables
 * (e.g., sc_trade_autopsies, sc_wallet_analyses) and sc_profiles snapshots.
 *
 * If you still need a universal audit trail, prefer a shared helper in jsonArtifacts.js.
 */

/**
 * Persist a generic AI job run to SQLite via BootyBox.
 *
 * Table: sc_job_runs
 * Columns: job_run_id (ULID), job, context(JSON), input(JSON), response_raw(JSON), created_at
 *
 * Usage:
 *   const jobRunId = await saveJobRun({
 *     job: 'walletDossier',
 *     context: { wallet, label: traderName },
 *     input: { merged },
 *     responseRaw: modelOutput
 *   });
 */
const logger = require('../logger');
const { requestId } = require('../id/issuer');
const BootyBox = require('../../db');

let _warnedDeprecation = false;
function warnDeprecatedOnce() {
  if (_warnedDeprecation) return;
  _warnedDeprecation = true;
  // eslint-disable-next-line no-console
  console.warn('[DEPRECATED] saveJobRun() is deprecated. Prefer sc_* domain tables + sc_profiles snapshots.');
}

/**
 * @typedef {Object} SaveJobRunParams
 * @property {string} job                     - CamelCase job name (e.g., 'walletDossier')
 * @property {Object|null} [context=null]     - Free-form tags (e.g., { wallet, tradeId, mint, label })
 * @property {Object} input                   - Input payload given to the job
 * @property {Object} responseRaw             - Raw model response payload
 */

/**
 * Save a job run and return its ULID.
 * @param {SaveJobRunParams} params
 * @returns {Promise<string>} jobRunId
 */
async function saveJobRun(params) {
  warnDeprecatedOnce();

  if (!params || typeof params !== 'object') {
    throw new Error('saveJobRun: params object is required');
  }
  const { job, context = null, input, responseRaw } = params;

  if (!job || typeof job !== 'string') {
    throw new Error('saveJobRun: `job` (string) is required');
  }
  if (!input) {
    throw new Error('saveJobRun: `input` is required');
  }
  if (typeof responseRaw === 'undefined') {
    throw new Error('saveJobRun: `responseRaw` is required');
  }

  const jobRunIdRaw = await requestId({ prefix: 'jobRun' });
  const jobRunId = String(jobRunIdRaw).slice(-26); // store bare ULID in DB

  await BootyBox.init();
  await BootyBox.recordJobRun({
    jobRunId,
    job,
    context,
    input,
    responseRaw,
  });

  if (process.env.NODE_ENV === 'development') {
    // Keep logging minimal to avoid noise in production
    logger.debug(`[job] saved run ${jobRunId} (${job})`);
  }

  return jobRunId;
}

module.exports = { saveJobRun };
