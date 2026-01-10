'use strict';

const defaultClient = require('../gptClient');
const { createWarlordAI } = require('../warlordAI');
const { buildFinalPayload } = require('../../lib/analysis/payloadBuilders');
const { queueVectorStoreUpload } = require('../../lib/ai/vectorStoreUpload');


/**
 * Create a trade autopsy runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeTradeAutopsy: (args: { payload: Object, model?: string }) => Promise<Object> }}
 */
function createTradeAutopsy(client) {
  const resolvedClient = client || defaultClient;
  const { runTask } = createWarlordAI({
    clients: { openai: resolvedClient },
    defaultProvider: 'openai',
  });
  const logger = resolvedClient.log || console;

  /**
   * Run the trade autopsy Responses job.
   *
   * @param {{ payload: Object, model?: string }} params
   * @returns {Promise<Object>}
   */
  async function analyzeTradeAutopsy({ payload, model }) {
    if (!payload) {
      throw new Error('[tradeAutopsy] missing payload');
    }
    const out = await runTask({
      task: 'tradeAutopsy',
      payload,
      model,
    });
    logger.debug('[tradeAutopsy] model output (truncated):', JSON.stringify(out).slice(0, 256));
    const finalPayload = buildFinalPayload({ prompt: payload, response: out });
    await queueVectorStoreUpload({
      source: 'autopsy',
      name: payload?.campaign?.token?.symbol || payload?.meta?.mint || null,
      data: finalPayload,
    }).catch((err) => logger.warn('[tradeAutopsy] vector store ingest failed:', err?.message));
    return out;
  }

  return { analyzeTradeAutopsy };
}

// Default instance using the shared client for convenience / backward compatibility.
const { analyzeTradeAutopsy } = createTradeAutopsy(defaultClient);

module.exports = {
  createTradeAutopsy,
  analyzeTradeAutopsy,
};
