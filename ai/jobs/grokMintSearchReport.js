'use strict';

const defaultClient = require('../grokClient');
const { createWarlordAI } = require('../warlordAI');

/**
 * Create a Grok mint search runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ runGrokMintSearchReport: (args: { mint: string, symbol?: string, aliases?: string[], model?: string, purpose?: string }) => Promise<Object> }}
 */
function createGrokMintSearchReport(client) {
  const resolvedClient = client || defaultClient;
  const { runTask } = createWarlordAI({
    clients: { grok: resolvedClient },
    defaultProvider: 'grok',
  });
  const logger = resolvedClient.log || console;

  async function runGrokMintSearchReport({ mint, symbol, aliases, model, purpose }) {
    const out = await runTask({
      task: 'grokMintSearchReport',
      payload: {
        mint,
        symbol,
        aliases,
        purpose,
      },
      model,
    });
    logger.debug('[grokMintSearchReport] model output (truncated):', JSON.stringify(out).slice(0, 256));
    return out;
  }

  return { runGrokMintSearchReport };
}

const { runGrokMintSearchReport } = createGrokMintSearchReport(defaultClient);

module.exports = {
  createGrokMintSearchReport,
  runGrokMintSearchReport,
};
