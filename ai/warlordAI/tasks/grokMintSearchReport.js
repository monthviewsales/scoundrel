'use strict';

const mintSearchSchema = require('../../schemas/grok.mint_search_report.v1.schema.json');

const SYSTEM = [
  'You are an X (Twitter) intel analyst producing a mint search report.',
  'Use the x_search tool to find mentions of the mint (and symbols/aliases if provided).',
  'Return ONLY JSON that matches the schema; no markdown.',
  'If you cannot get time-windowed counts, set them to null and explain why in x_mentions.notes.',
  'Keep summary concise and operator-facing.'
].join(' ');

/**
 * Build the user payload for a Grok mint search report task.
 * @param {{ mint: string, symbol?: string, aliases?: string[], purpose?: string }} payload
 * @returns {{ mint: string, symbol: string|null, aliases: string[], purpose: string }}
 */
function buildUser(payload) {
  const safePayload = payload || {};
  if (!safePayload.mint || typeof safePayload.mint !== 'string') {
    throw new Error('[grokMintSearchReport] mint is required');
  }

  return {
    mint: safePayload.mint,
    symbol: safePayload.symbol || null,
    aliases: Array.isArray(safePayload.aliases) ? safePayload.aliases : [],
    purpose: safePayload.purpose || 'Report how much this mint is being discussed on X.',
  };
}

module.exports = {
  name: 'grok_mint_search_report_v1',
  schema: mintSearchSchema,
  system: SYSTEM,
  provider: 'grok',
  temperature: 0.3,
  tools: [{ type: 'x_search' }],
  tool_choice: 'auto',
  buildUser,
};
