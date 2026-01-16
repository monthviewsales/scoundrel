'use strict';

// ai/jobs/tuneStrategy.js
const defaultClient = require('../gptClient');
const { createWarlordAI } = require('../warlordAI');

/**
 * Create a tune strategy job runner.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: any }} client
 * @returns {{ runTuneStrategy: Function }}
 */
function createTuneStrategyJob(client) {
  const { runTask } = createWarlordAI(client || defaultClient);

  /**
   * Execute the tune strategy Responses job.
   * @param {Object} params
   * @param {Object} params.strategy
   * @param {{ name?: string, path?: string }} [params.strategyMeta]
   * @param {Object|null} [params.profile=null]
   * @param {Array<{ role: 'user'|'assistant', content: string }>} [params.history]
   * @param {string} params.question
   * @param {string} [params.model]
 * @param {number} [params.temperature]
   * @returns {Promise<Object>}
   */
  async function runTuneStrategy({
    strategy,
    strategyMeta,
    profile = null,
    history = [],
    question,
    model,
    temperature,
  }) {
    return runTask({
      task: 'tuneStrategy',
      payload: {
        strategy,
        strategyMeta: strategyMeta || null,
        profile,
        history,
        question,
      },
      model,
      temperature,
    });
  }

  return { runTuneStrategy };
}

const { runTuneStrategy } = createTuneStrategyJob(defaultClient);

module.exports = { createTuneStrategyJob, runTuneStrategy };
