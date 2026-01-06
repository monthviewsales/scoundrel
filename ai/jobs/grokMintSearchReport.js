'use strict';

const defaultClient = require('../grokClient');
const mintSearchSchema = require('../schemas/grok.mint_search_report.v1.schema.json');

const SYSTEM = [
  'You are an X (Twitter) intel analyst producing a mint search report.',
  'Use the x_search tool to find mentions of the mint (and symbols/aliases if provided).',
  'Return ONLY JSON that matches the schema; no markdown.',
  'If you cannot get time-windowed counts, set them to null and explain why in x_mentions.notes.',
  'Keep summary concise and operator-facing.'
].join(' ');

/**
 * Create a Grok mint search runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ runGrokMintSearchReport: (args: { mint: string, symbol?: string, aliases?: string[], model?: string, purpose?: string }) => Promise<Object> }}
 */
function createGrokMintSearchReport(client) {
  const { callResponses, parseResponsesJSON, log } = client || defaultClient;
  const logger = log || console;

  async function runGrokMintSearchReport({ mint, symbol, aliases, model, purpose }) {
    if (!mint || typeof mint !== 'string') {
      throw new Error('[grokMintSearchReport] mint is required');
    }

    const user = {
      mint,
      symbol: symbol || null,
      aliases: Array.isArray(aliases) ? aliases : [],
      purpose: purpose || 'Report how much this mint is being discussed on X.',
    };

    const res = await callResponses({
      system: SYSTEM,
      model,
      name: 'grok_mint_search_report_v1',
      schema: mintSearchSchema,
      user,
      temperature: 0.3,
      tools: [{ type: 'x_search' }],
      tool_choice: 'auto',
    });

    const out = parseResponsesJSON(res);
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
