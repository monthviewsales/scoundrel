'use strict';

const { callResponses, parseResponsesJSON, log } = require('../client');

const SYSTEM = [
  "You are Warlord's trade autopsy engine.",
  "You receive JSON describing a trader's single Solana memecoin campaign for one token for one wallet, including all trades, realized PnL, metrics, price range, token PnL, all-time high, and a window of OHLCV candles around the campaign.",
  "Your job is to perform a realistic post-mortem of how the coin's campaign was executed: judge entries and exits, identify what went well, highlight mistakes, and propose specific improvements without hindsight bias.",
  "Assume the trader is an active Solana memecoin degen; keep the tone direct, practical, and slightly degen-friendly without being cringe.",
  "Use only provided numbers and candles; do not invent prices or timestamps.",
  "In addition to grading and analysis, you must generate an 'ideal replay' of how YOU would have traded the same coin in the same time window with the same maximum capital the user deployed.",
  "For the ideal replay: stay realistic, stay inside the candle highs/lows, and do not invent impossible trades. The simulated trades must use timestamps within the campaign window and prices that fall within real candle ranges.",
  "Derive the startingCapitalSol from the user's actual maximum deployed capital. Prefer marketContext.tokenPnL.total_invested if available; otherwise derive it from the user's trades and metrics.",
  "Your idealReplay must include: (1) a short summary, (2) startingCapitalSol, (3) projectedProfitSol and projectedProfitPercent, (4) a list of keyTechniques explaining what you would do differently, (5) simulatedTrades showing realistic buys and sells in order (each with timestamp, side, amountSol, priceUsd, and reason), and (6) a brief notes section explaining why your simulated plan is more profitable without relying on hindsight bias.",
  "Return ONLY valid JSON following the schema. No markdown. No extra commentary."
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
    idealReplay: {
      type: 'object',
      description: 'Alternative, more profitable way WarlordAI would have traded this campaign with the same capital and time window.',
      properties: {
        summary: { type: 'string' },
        startingCapitalSol: {
          type: 'number',
          description: 'Maximum capital (in SOL) available for this simulated strategy.',
        },
        projectedProfitSol: {
          type: 'number',
          description: 'Net profit (in SOL) for the simulated strategy.',
        },
        projectedProfitPercent: {
          type: 'number',
          description: 'Percent return on startingCapitalSol for the simulated strategy.',
        },
        keyTechniques: {
          type: 'array',
          description: 'Concrete techniques or behaviors that differ from the user’s actual trading.',
          items: { type: 'string' },
        },
        simulatedTrades: {
          type: 'array',
          description: 'Sequence of simulated buys and sells over the same time window.',
          items: {
            type: 'object',
            properties: {
              timestamp: {
                type: 'number',
                description: 'Timestamp in milliseconds since epoch, within the campaign window.',
              },
              side: {
                type: 'string',
                enum: ['buy', 'sell'],
              },
              amountSol: {
                type: 'number',
                description: 'Size of the trade in SOL (not including fees).',
              },
              amountToken: {
                type: 'number',
                description: 'Optional: size of the trade in token units, if known.',
              },
              priceUsd: {
                type: 'number',
                description: 'Approximate execution price in USD.',
              },
              reason: {
                type: 'string',
                description: 'Short explanation of why this trade is taken at this time and price.',
              },
            },
            required: ['timestamp', 'side', 'amountSol', 'amountToken', 'priceUsd', 'reason'],
            additionalProperties: false,
          },
        },
        notes: {
          type: 'string',
          description: 'Narrative explanation of how this simulated plan differs from the user’s and why it is more profitable.',
        },
      },
      required: [
        'summary',
        'startingCapitalSol',
        'projectedProfitSol',
        'projectedProfitPercent',
        'keyTechniques',
        'simulatedTrades',
        'notes',
      ],
      additionalProperties: false,
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
      maxItems: 8,
    },
  },
  required: ['grade', 'summary', 'entryAnalysis', 'exitAnalysis', 'riskManagement', 'profitability', 'lessons', 'idealReplay', 'tags'],
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
    name: 'trade_autopsy_v2',
    schema: RESPONSE_SCHEMA,
    user: { campaign: payload },
    temperature: 0.2,
  });

  const out = parseResponsesJSON(res);
  log.debug('[tradeAutopsy] model output (truncated):', JSON.stringify(out).slice(0, 200));
  return out;
}

module.exports = { analyzeTradeAutopsy };
