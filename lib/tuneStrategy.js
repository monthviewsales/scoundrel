'use strict';
// lib/tuneStrategy.js (orchestrator)
// CLI processor for "tune" that delegates AI work to ai/jobs/tuneStrategy.js (pure job),
// persists results to sc_job_runs (generic) and sc_tunes (specific), and returns CLI-friendly text.

require('dotenv').config();
const { log } = require('../ai/client');
const { query } = require('../db/mysql');
const { requestId } = require('../id/issuer');
const { saveJobRun } = require('./persist/saveJobRun');

// The pure job to be created: ai/jobs/tuneStrategy.js
// It must export: async function run({ profile, currentSettings, model, temperature }) -> parsed JSON
const { run } = require('../ai/jobs/tuneStrategy');

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
    await query(
      `INSERT INTO sc_tunes (
        tune_id, correlation_id, profile, current_settings, model, temperature, response_raw, answer, bullets, actions, changes, patch, risks, rationale
      ) VALUES (
        :tune_id, :correlation_id, CAST(:profile AS JSON), CAST(:current_settings AS JSON), :model, :temperature, CAST(:response_raw AS JSON), :answer, CAST(:bullets AS JSON), CAST(:actions AS JSON), CAST(:changes AS JSON), CAST(:patch AS JSON), CAST(:risks AS JSON), :rationale
      )`,
      {
        tune_id: tuneId,
        correlation_id: tuneId,
        profile: profile ? JSON.stringify(profile) : null,
        current_settings: currentSettings ? JSON.stringify(currentSettings) : null,
        model,
        temperature,
        response_raw: JSON.stringify(out), // storing parsed JSON for v1
        answer: out.answer || '',
        bullets: JSON.stringify(Array.isArray(out.bullets) ? out.bullets : []),
        actions: JSON.stringify(Array.isArray(out.actions) ? out.actions : []),
        changes: JSON.stringify(out && typeof out.changes === 'object' ? out.changes : {}),
        patch: JSON.stringify(Array.isArray(out.patch) ? out.patch : []),
        risks: JSON.stringify(Array.isArray(out.risks) ? out.risks : []),
        rationale: typeof out.rationale === 'string' ? out.rationale : ''
      }
    );
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