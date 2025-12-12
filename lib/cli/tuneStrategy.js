'use strict';
// lib/tuneStrategy.js (orchestrator)
// CLI processor for "tune" that delegates AI work to ai/jobs/tuneStrategy.js (pure job),
// persists results to sc_job_runs (generic) and sc_tunes (specific), and returns CLI-friendly text.

require('dotenv').config();
const logger = require('../../.logger');
const { log } = require('../../ai/client');
const BootyBox = require('../../db');
const { requestId } = require('../id/issuer');
const { saveJobRun } = require('../persist/saveJobRun');

// The pure job to be created: ai/jobs/tuneStrategy.js
// It must export: async function run({ profile, currentSettings, model, temperature }) -> parsed JSON
const { run } = require('../../ai/jobs/tuneStrategy');

/**
 * @param {Object} args
 * @param {Object} [args.profile]          - Trader profile JSON
 * @param {Object} [args.currentSettings]  - Current strategy/config settings (object)
 * @returns {Promise<string>}              - Readable advice with bullets/actions and JSON blocks
 */
module.exports = async function tuneStrategy({ profile, currentSettings }) {
  const model = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';
  const temperature = 0.2;

  // Generate an event-driven ULID for the specific table
  const tuneIdRaw = await requestId({ prefix: 'tune' });
  const tuneId = String(tuneIdRaw).slice(-26);

  // Call the pure job (prompt/schema/parse lives there)
  const out = await run({
    profile: profile || null,
    currentSettings: currentSettings || null,
    model,
    temperature,
  });

  if (process.env.NODE_ENV === 'development') {
    log.debug('[tuneStrategy] model output (truncated):', JSON.stringify(out).slice(0, 500));
  }

  // Persist generic job run (one row per job execution)
  try {
    await saveJobRun({
      job: 'tuneStrategy',
      context: { label: 'strategy' },
      input: { profile: profile || null, currentSettings: currentSettings || null },
      responseRaw: out,
    });
    if (process.env.NODE_ENV === 'development') log.info('[tuneStrategy] saved job run (sc_job_runs)');
  } catch (e) {
    log.warn('[tuneStrategy] failed to save job run:', e?.message || e);
  }

  // Persist specific table (sc_tunes) with parsed response as response_raw for v1
  try {
    await BootyBox.init();
    await BootyBox.recordTune({
      tuneId,
      correlationId: tuneId,
      profile,
      currentSettings,
      model,
      temperature,
      responseRaw: out,
      answer: out.answer || '',
      bullets: out.bullets,
      actions: out.actions,
      changes: out && typeof out.changes === 'object' ? out.changes : {},
      patch: out.patch,
      risks: out.risks,
      rationale: out.rationale,
    });
    if (process.env.NODE_ENV === 'development') {
      log.info(`[tuneStrategy] persisted tune ${tuneId}`);
      log.info(`[tuneStrategy] id: ${tuneId}`);
    }
  } catch (dbErr) {
    log.warn && log.warn('[tuneStrategy] failed to persist tune:', dbErr.message || dbErr);
  }

  // Format CLI-friendly output
  let result = out.answer || '';
  if (Array.isArray(out.bullets) && out.bullets.length) {
    result += '\n\n• ' + out.bullets.join('\n• ');
  }
  if (Array.isArray(out.actions) && out.actions.length) {
    result += '\n\nNext actions:\n- ' + out.actions.join('\n- ');
  }
  if (out.risks && Array.isArray(out.risks) && out.risks.length) {
    result += '\n\nRisks:\n- ' + out.risks.join('\n- ');
  }
  if (typeof out.rationale === 'string' && out.rationale.trim()) {
    result += `\n\nWhy: ${out.rationale.trim()}`;
  }
  if (out.changes && typeof out.changes === 'object' && Object.keys(out.changes).length) {
    result += '\n\nProposed changes (JSON):\n' + JSON.stringify(out.changes, null, 2);
  }
  if (Array.isArray(out.patch) && out.patch.length) {
    result += '\n\nJSON Patch:\n' + JSON.stringify(out.patch, null, 2);
  }

  return result.trim();
};
