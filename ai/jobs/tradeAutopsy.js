'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const defaultClient = require('../gptClient');
const { createWarlordAI } = require('../warlordAI');

const AUTOPSY_VECTOR_STORE_ID = process.env.AUTOPSY_VECTOR_STORE_ID || 'vs_695c25edadd481918b3be75989e5b8eb';


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
      const vectorStores = openai.vectorStores || (openai.beta && openai.beta.vectorStores);
      if (!vectorStores) {
        throw new Error('Vector store API not available on OpenAI client');
      }
      if (vectorStores.fileBatches && typeof vectorStores.fileBatches.create === 'function') {
        await vectorStores.fileBatches.create(AUTOPSY_VECTOR_STORE_ID, {
          file_ids: [file.id],
        });
      } else if (vectorStores.files && typeof vectorStores.files.create === 'function') {
        await vectorStores.files.create(AUTOPSY_VECTOR_STORE_ID, {
          file_id: file.id,
        });
      } else {
        throw new Error('Vector store attach API not available on OpenAI client');
      }
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
    const out = await runTask({
      task: 'tradeAutopsy',
      payload,
      model,
    });
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
