

// lib/tune.js
// Processor for "tune" CLI command — proposes strategy tweaks via the Responses-first AI client.
// Exports a default async function that returns a readable string with optional structured changes appended.

require('dotenv').config();
const { callResponses, parseResponsesJSON, log } = require('../ai/client');

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
        additionalProperties: true,
        properties: {},
        description: 'Partial settings object with proposed updates (only fields that should change).'
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
            value: {}
          },
          required: ['op','path']
        }
      },
      risks: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' }
    },
    required: ['answer']
  }
};

const SYSTEM = [
  'You are Scoundrel, an expert Solana memecoin strategy tuner.',
  'Use ONLY the provided JSON context (profile + currentSettings). Do not invent data.',
  'Propose safe, incremental changes that improve profitability and reduce risk.',
  'If you propose settings changes, include them under `changes` as a partial JSON object (only fields that change).',
  'Optionally include a JSON Patch array under `patch` for precise modifications.',
  'Return JSON that matches the schema exactly (answer + optional bullets/actions/changes/patch/risks/rationale). No prose outside JSON.'
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

  const res = await callResponses({
    schema: TUNE_V1_SCHEMA,
    name: TUNE_V1_SCHEMA.name,
    system: SYSTEM,
    user,
    model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini',
    temperature: 0.2
  });

  const out = parseResponsesJSON(res);
  if (process.env.NODE_ENV === 'development') {
    log.debug('[tune] model output:', out);
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