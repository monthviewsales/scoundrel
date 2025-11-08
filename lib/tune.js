// lib/tune.js
// Processor for "tune" CLI command — proposes strategy tweaks via the Responses-first AI client.
// Exports a default async function that returns a readable string with optional structured changes appended.

require('dotenv').config();
const { callResponses, parseResponsesJSON, log } = require('../ai/client');
const { query } = require('../db/mysql');
const { requestId } = require('../id/issuer');

// Keep the schema strict but only require `answer` so optional fields don't break strict mode
const TUNE_V1_SCHEMA = {
  name: 'tune_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string' },
      bullets: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: { type: 'string' } },
      // Proposed settings changes (partial object). Kept loose to allow arbitrary keys.
      changes: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        description: 'Partial settings object. In strict mode we return an empty object unless a fixed key list is defined.'
      },
      // Optional JSON Patch operations if you prefer patch semantics later
      patch: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op:   { type: 'string', enum: ['add','remove','replace'] },
            path: { type: 'string' },
            value: {
              type: ['string','number','boolean','null']
            }
          },
          required: ['op','path','value']
        }
      },
      risks: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' }
    },
    required: ['answer','bullets','actions','changes','patch','risks','rationale']
  }
};

const SYSTEM = [
  'You are Scoundrel, an expert Solana memecoin strategy tuner.',
  'Use ONLY the provided JSON context (profile + currentSettings). Do not invent data.',
  'Propose safe, incremental changes that improve profitability and reduce risk.',
  'If you propose settings changes, include them under `changes` as a partial JSON object (only fields that change).',
  'Optionally include a JSON Patch array under `patch` for precise modifications.',
  'Return JSON that matches the schema exactly (answer + bullets + actions + changes + patch + risks + rationale). Use empty arrays/empty object when you have nothing to add. No prose outside JSON.'
].join(' ');

/**
 * @param {Object} args
 * @param {Object} [args.profile]          - Trader profile JSON
 * @param {Object} [args.currentSettings]  - Current strategy/config settings (object)
 * @returns {Promise<string>}              - Readable advice string with optional bullets/actions and a JSON block of `changes` if present
 */
module.exports = async function tuneProcessor({ profile, currentSettings }) {
  const user = {
    profile: profile || null,
    currentSettings: currentSettings || null
  };

  const model = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';
  const temperature = 0.2;
  // Generate a tune_id via the event-driven ULID issuer
  const tuneId = await requestId({ prefix: 'tune' });

  const res = await callResponses({
    schema: TUNE_V1_SCHEMA.schema, // pass the JSON Schema object, not the wrapper
    name: TUNE_V1_SCHEMA.name,
    system: SYSTEM,
    user,
    model,
    temperature,
  });

  const out = parseResponsesJSON(res);
  if (process.env.NODE_ENV === 'development') {
    log.debug('[tune] model output:', out);
  }

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
        profile: JSON.stringify(user.profile),
        current_settings: JSON.stringify(user.currentSettings),
        model,
        temperature,
        response_raw: JSON.stringify(res),
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
      log.info(`[tune] persisted tune ${tuneId}`);
    }
  } catch (dbErr) {
    log.warn && log.warn('[tune] failed to persist tune:', dbErr.message || dbErr);
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

  // Append a compact JSON block with proposed `changes` if provided
  if (out.changes && typeof out.changes === 'object' && Object.keys(out.changes).length) {
    result += '\n\nProposed changes (JSON):\n' + JSON.stringify(out.changes, null, 2);
  }
  // If JSON Patch operations are present, append them too
  if (Array.isArray(out.patch) && out.patch.length) {
    result += '\n\nJSON Patch:\n' + JSON.stringify(out.patch, null, 2);
  }

  return result.trim();
};