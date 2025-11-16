'use strict';

const { callResponses, parseResponsesJSON, log } = require('../client');

const SYSTEM = [
  'You are Warlord\'s trade autopsy engine.',
  'You receive JSON describing a single campaign in one token for one wallet, including all trades, realized PnL, metrics, price range, token PnL, all-time high, and a window of OHLCV candles around the campaign.',
  'Your job is to perform a realistic post-mortem of how the campaign was executed: judge entries and exits, identify what went well, highlight mistakes, and propose specific improvements without hindsight bias.',
  'Assume the trader is an active Solana memecoin degen; keep the tone direct, practical, and slightly degen-friendly without being cringe.',
  'Use only provided numbers and candles; do not invent prices or timestamps. Respond only with JSON following the schema. No markdown.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    grade: { type: 'string' },
    summary: { type: 'string' },
    entryAnalysis: { type: 'string' },
    exitAnalysis: { type: 'string' },
    riskManagement: { type: 'string' },
    profitability: { type: 'string' },
    lessons: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
      maxItems: 8,
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
      maxItems: 8,
    },
  },
  required: ['grade', 'summary', 'entryAnalysis', 'exitAnalysis', 'riskManagement', 'profitability', 'lessons', 'tags'],
  additionalProperties: false,
};

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

  const res = await callResponses({
    system: SYSTEM,
    model,
    name: 'trade_autopsy_v1',
    schema: RESPONSE_SCHEMA,
    user: { campaign: payload },
    temperature: 0.2,
  });

  const out = parseResponsesJSON(res);
  log.debug('[tradeAutopsy] model output (truncated):', JSON.stringify(out).slice(0, 200));
  return out;
}

module.exports = { analyzeTradeAutopsy };
