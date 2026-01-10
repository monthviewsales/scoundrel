'use strict';

const schema = require('../../schemas/tuneStrategy.v3.schema.json');

const NAME = 'tune_strategy_v3';

const SYSTEM = [
  'You are Scoundrel, an expert Solana memecoin strategy tuner.',
  'Use ONLY the provided JSON context (strategy + profile + history + question + meta). Do not invent data.',
  'Give practical, safe, incremental suggestions for adjusting the strategy.',
  'If you propose settings changes, include them under `changes` as a JSON string containing only the fields that change (use "{}" when none).',
  'Optionally include a JSON Patch array under `patch` with string values (use "" when no value is needed).',
  'Include follow-up questions under `questions` when you need clarification.',
  'Return JSON that matches the schema exactly. Use empty arrays/empty objects when you have nothing to add. No prose outside JSON.',
].join(' ');

/**
 * Build the user payload for the tune strategy task.
 * @param {{ strategy: Object, strategyMeta?: Object, profile?: Object|null, history?: Array, question?: string, meta?: Object }} payload
 * @returns {{ strategy: Object, strategyMeta: Object|null, profile: Object|null, history: Array, question: string|undefined, meta: Object|null }}
 */
function buildUser(payload) {
  const safePayload = payload || {};
  return {
    meta: safePayload.meta || null,
    strategy: safePayload.strategy,
    strategyMeta: safePayload.strategyMeta || null,
    profile: safePayload.profile || null,
    history: Array.isArray(safePayload.history) ? safePayload.history : [],
    question: safePayload.question,
  };
}

module.exports = {
  name: NAME,
  schema,
  system: SYSTEM,
  buildUser,
};
