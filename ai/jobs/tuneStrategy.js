'use strict';

// ai/jobs/tuneStrategy.js
const defaultClient = require('../gptClient');
const schema = require('../schemas/tuneStrategy.v2.schema.json');

const NAME = 'tune_strategy_v2';

const SYSTEM = [
  'You are Scoundrel, an expert Solana memecoin strategy tuner.',
  'Use ONLY the provided JSON context (strategy + profile + history + question). Do not invent data.',
  'Give practical, safe, incremental suggestions for adjusting the strategy.',
  'If you propose settings changes, include them under `changes` as a partial JSON object (only fields that change).',
  'Optionally include a JSON Patch array under `patch` for precise modifications.',
  'Include follow-up questions under `questions` when you need clarification.',
  'Return JSON that matches the schema exactly. Use empty arrays/empty objects when you have nothing to add. No prose outside JSON.',
].join(' ');

/**
 * Create a tune strategy job runner.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: any }} client
 * @returns {{ runTuneStrategy: Function }}
 */
function createTuneStrategyJob(client) {
  const { callResponses, parseResponsesJSON } = client;

  /**
   * Execute the tune strategy Responses job.
   * @param {Object} params
   * @param {Object} params.strategy
   * @param {{ name?: string, path?: string }} [params.strategyMeta]
   * @param {Object|null} [params.profile=null]
   * @param {Array<{ role: 'user'|'assistant', content: string }>} [params.history]
   * @param {string} params.question
   * @param {string} [params.model]
   * @param {number} [params.temperature=0.2]
   * @returns {Promise<Object>}
   */
  async function runTuneStrategy({
    strategy,
    strategyMeta,
    profile = null,
    history = [],
    question,
    model,
    temperature = 0.2,
  }) {
    const res = await callResponses({
      schema,
      name: NAME,
      system: SYSTEM,
      user: {
        strategy,
        strategyMeta: strategyMeta || null,
        profile,
        history,
        question,
      },
      model,
      temperature,
    });

    return parseResponsesJSON(res);
  }

  return { runTuneStrategy };
}

const { runTuneStrategy } = createTuneStrategyJob(defaultClient);

module.exports = { createTuneStrategyJob, runTuneStrategy };
