'use strict';

const defaultClient = require('../grokClient');
const { createWarlordAI } = require('../warlordAI');

/**
 * Create a Grok profile scoring runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ runGrokProfileScore: (args: { handle: string, profileUrl?: string, profile?: Object, model?: string, purpose?: string }) => Promise<Object> }}
 */
function createGrokProfileScore(client) {
  const resolvedClient = client || defaultClient;
  const { runTask } = createWarlordAI({
    clients: { grok: resolvedClient },
    defaultProvider: 'grok',
  });
  const logger = resolvedClient.log || console;

  async function runGrokProfileScore({ handle, profileUrl, profile, model, purpose }) {
    const out = await runTask({
      task: 'grokProfileScore',
      payload: {
        handle,
        profileUrl,
        profile,
        purpose,
      },
      model,
    });
    logger.debug('[grokProfileScore] model output (truncated):', JSON.stringify(out).slice(0, 256));
    return out;
  }

  return { runGrokProfileScore };
}

const { runGrokProfileScore } = createGrokProfileScore(defaultClient);

module.exports = {
  createGrokProfileScore,
  runGrokProfileScore,
};
