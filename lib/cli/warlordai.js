'use strict';

const logger = require('../logger');
const { createWarlordAIClient } = require('../warchest/warlordAIClient');

const DEFAULT_MODEL = null;

/**
 * Format an ask response into a plain-text answer.
 *
 * @param {{ answer?: string, bullets?: string[], actions?: string[] }} output
 * @returns {string}
 */
function formatAskOutput(output) {
  const out = output || {};
  let result = out.answer || '';
  if (Array.isArray(out.bullets) && out.bullets.length) {
    result += '\n\n• ' + out.bullets.join('\n• ');
  }
  if (Array.isArray(out.actions) && out.actions.length) {
    result += '\n\nNext actions:\n- ' + out.actions.join('\n- ');
  }
  return result.trim();
}

/**
 * Run a single WarlordAI ask request.
 *
 * @param {Object} params
 * @param {string} params.question
 * @param {string} [params.sessionId]
 * @param {boolean} [params.rag]
 * @param {string} [params.model]
 * @param {number} [params.timeoutMs]
 * @param {ReturnType<typeof createWarlordAIClient>} [params.client]
 * @returns {Promise<{ sessionId: string|null, output: Object, text: string }>} Result bundle.
 */
async function runWarlordAIAsk({ question, sessionId, rag, model, timeoutMs, client } = {}) {
  if (!question || typeof question !== 'string') {
    throw new Error('[warlordai] question (string) is required');
  }

  const normalizedQuestion = question.trim().replace(/\s+/g, ' ');
  const resolvedModel = (typeof model === 'string' && model.trim().length)
    ? model.trim()
    : DEFAULT_MODEL;
  const useClient = client || createWarlordAIClient({ sessionId, logger });
  let response;

  try {
    response = await useClient.request({
      task: 'ask',
      payload: { question: normalizedQuestion },
      model: resolvedModel,
      rag: typeof rag === 'boolean' ? rag : undefined,
    }, { timeoutMs });
  } finally {
    if (!client && useClient && typeof useClient.close === 'function') {
      useClient.close();
    }
  }

  const output = response && response.result ? response.result : {};
  return {
    sessionId: response && response.sessionId ? response.sessionId : sessionId || null,
    output,
    text: formatAskOutput(output),
  };
}

module.exports = {
  formatAskOutput,
  runWarlordAIAsk,
};
