'use strict';

// ai/jobs/tuneStrategy.js
const { callResponses, parseResponsesJSON } = require('../gptcClient');
const schema = require('../schemas/tuneStrategy.v1.schema.json');

const NAME = 'tune_strategy_v1';

const SYSTEM = [
  'You are Scoundrel, an expert Solana memecoin strategy tuner.',
  'Use ONLY the provided JSON context (profile + currentSettings). Do not invent data.',
  'Propose safe, incremental changes that improve profitability and reduce risk.',
  'If you propose settings changes, include them under `changes` as a partial JSON object (only fields that change).',
  'Optionally include a JSON Patch array under `patch` for precise modifications.',
  'Return JSON that matches the schema exactly (answer + bullets + actions + changes + patch + risks + rationale). Use empty arrays/empty object when you have nothing to add. No prose outside JSON.'
].join(' ');

/**
 * Execute the tune strategy Responses job.
 * @param {Object} params
 * @param {Object|null} [params.profile=null]
 * @param {Object|null} [params.currentSettings=null]
 * @param {string} [params.model]
 * @param {number} [params.temperature=0.2]
 * @returns {Promise<Object>}
 */
async function run({ profile = null, currentSettings = null, model, temperature = 0.2 }) {
  const res = await callResponses({
    schema,
    name: NAME,
    system: SYSTEM,
    user: { profile, currentSettings },
    model,
    temperature
  });
  return parseResponsesJSON(res);
}

module.exports = { run };