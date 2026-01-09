'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const defaultClient = require('../gptClient');
const tradeAutopsySchema = require('../schemas/trade_autopsy_v2.schema.json');

const AUTOPSY_VECTOR_STORE_ID = process.env.AUTOPSY_VECTOR_STORE_ID || 'vs_695c25edadd481918b3be75989e5b8eb';

const SYSTEM = [
  "You are Warlord's trade autopsy engine.",
  "You receive JSON describing a trader's single Solana memecoin campaign for one token for one wallet, including all trades, realized PnL, metrics, price range, token PnL, all-time high, and a window of OHLCV candles around the campaign.",
  "Your job is to perform a realistic post-mortem of how the coin's campaign was executed: judge entries and exits, identify what went well, highlight mistakes, and propose specific improvements without hindsight bias.",
  "Assume the trader is an active Solana memecoin degen; keep the tone direct, practical, and slightly degen-friendly without being cringe.",
  "Use only provided numbers and candles; do not invent prices or timestamps.",

  // 🔥 UNITS & FIELD MEANING (CRITICAL) 🔥
  "Pay very close attention to units:",
  "- Fields under marketContext.tokenPnL such as realized, total_invested, total_sold, total, sold_usd and total_sold are all DENOMINATED IN USD, not SOL.",
  "- campaign.metrics.realizedPnLUsd, avgEntryPrice, and avgExitPrice are denominated in USD. Treat them as USD values.",
  "- For each trade: amount = token units, priceUsd = USD per token, volume = USD notional for that trade, and volumeSol = SOL actually spent/received.",
  "- When you talk about profit, loss, capital, and returns, treat these values as USD unless you explicitly say you are converting into SOL.",
  "- Never call a USD amount 'SOL' in your text. If you say 'x SOL', that must refer to a quantity of SOL, not USD.",

  // 🔁 IDEAL REPLAY IN TERMS OF THESE UNITS
  "In addition to grading and analysis, you must generate an 'ideal replay' of how YOU would have traded the same coin in the same time window with the same maximum capital the user deployed.",
  "Derive the startingCapitalUsd field from the user's actual maximum deployed capital in USD. Prefer marketContext.tokenPnL.total_invested if available; otherwise derive it from the user's trades and metrics.",
  "For the ideal replay: stay realistic, stay inside the candle highs/lows, and do not invent impossible trades. The simulated trades must use timestamps within the campaign window and prices that fall within real candle ranges.",
    "Your idealReplay must include: (1) a short summary, (2) startingCapitalUsd (USD capital), (3) projectedProfitUsd (USD profit for your plan) and projectedProfitPercent, (4) a list of keyTechniques explaining what you would do differently, (5) simulatedTrades showing realistic buys and sells in order (each with timestamp, side, amountSol, amountToken, priceUsd, and reason), and (6) a brief notes section explaining why your simulated plan is more profitable without relying on hindsight bias.",
  "For simulatedTrades: amountSol should represent the SOL size of each trade, priceUsd should be the USD token price, and amountToken should be token units. Do not put USD values into amountSol.",
  "Return ONLY valid JSON following the schema. No markdown. No extra commentary."
].join(' ');

const RESPONSE_SCHEMA = tradeAutopsySchema;

/**
 * Create a trade autopsy runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeTradeAutopsy: (args: { payload: Object, model?: string }) => Promise<Object> }}
 */
function createTradeAutopsy(client) {
  const { callResponses, parseResponsesJSON, log } = client || defaultClient;
  const logger = log || console;

  async function saveAutopsyToVectorStore({ analysis, payload }) {
    if (!AUTOPSY_VECTOR_STORE_ID) {
      logger.warn('[tradeAutopsy] Missing vector store id; skipping vector store ingest');
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('[tradeAutopsy] OPENAI_API_KEY missing; skipping vector store ingest');
      return;
    }

    const campaign = payload?.campaign || {};
    const token = payload?.token || {};
    const wallet = payload?.wallet || {};
    const metadata = {
      kind: 'autopsy.analysis',
      generatedAt: new Date().toISOString(),
      walletAddress: wallet.address || null,
      walletLabel: wallet.label || null,
      mint: token.mint || null,
      tokenSymbol: token.symbol || null,
      campaignStart: campaign.startTimestamp || null,
      campaignEnd: campaign.endTimestamp || null,
      analysis,
    };

    const content = JSON.stringify(metadata);
    const tmpPath = path.join(os.tmpdir(), `autopsy-${randomUUID()}.json`);
    try {
      logger.warn('[tradeAutopsy] Ingesting autopsy into vector store', { vectorStore: AUTOPSY_VECTOR_STORE_ID });
      await fs.promises.writeFile(tmpPath, content, 'utf8');
      const openai = new OpenAI({ apiKey });
      const file = await openai.files.create({
        file: fs.createReadStream(tmpPath),
        purpose: 'assistants',
      });
      logger.debug('[tradeAutopsy] Uploaded file for vector store', { fileId: file.id });
      await openai.vectorStores.fileBatches.create(AUTOPSY_VECTOR_STORE_ID, {
        fileIds: [file.id],
      });
      logger.warn('[tradeAutopsy] Stored analysis in vector store', { vectorStore: AUTOPSY_VECTOR_STORE_ID, fileId: file.id });
    } catch (err) {
      logger.warn('[tradeAutopsy] Failed to store analysis in vector store:', err?.message || err);
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
    }
  }

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
      name: 'trade_autopsy_v2_3',
      schema: RESPONSE_SCHEMA,
      user: { campaign: payload },
    });

    const out = parseResponsesJSON(res);
    logger.debug('[tradeAutopsy] model output (truncated):', JSON.stringify(out).slice(0, 256));
    await saveAutopsyToVectorStore({ analysis: out, payload })
      .catch((err) => logger.warn('[tradeAutopsy] vector store ingest failed:', err?.message));
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
