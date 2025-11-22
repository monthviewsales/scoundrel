'use strict';

/**
 * Persist a generic AI job run to MySQL.
 *
 * Table: sc_job_runs
 * Columns: job_run_id (ULID), job, context(JSON), input(JSON), response_raw(JSON), created_at
 *
 * Usage:
 *   const jobRunId = await saveJobRun({
 *     job: 'walletAnalysis',
 *     context: { wallet, label: traderName },
 *     input: { merged },
 *     responseRaw: modelOutput
 *   });
 */

const { requestId } = require('../id/issuer');
const BootyBox = require('../packages/bootybox');

/**
 * @typedef {Object} SaveJobRunParams
 * @property {string} job                     - CamelCase job name (e.g., 'walletAnalysis')
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
    console.debug(`[job] saved run ${jobRunId} (${job})`);
  }

  return jobRunId;
}

module.exports = { saveJobRun };
