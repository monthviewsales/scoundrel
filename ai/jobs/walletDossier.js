'use strict';

const defaultClient = require('../gptClient');
const { createWarlordAI } = require('../warlordAI');
const { buildFinalPayload } = require('../../lib/analysis/payloadBuilders');
const { queueVectorStoreUpload } = require('../../lib/ai/vectorStoreUpload');


/**
 * Create a wallet analysis runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeWallet: (args: { merged: Object, model?: string, purpose?: string }) => Promise<{ version: string, markdown: string, operator_summary?: Object }> }}
 */
function createWalletAnalysis(client) {
  const resolvedClient = client || defaultClient;
  const { runTask } = createWarlordAI({
    clients: { openai: resolvedClient },
    defaultProvider: 'openai',
  });
  const logger = resolvedClient.log || console;

  /**
   * Extract a best-effort text payload from a raw response.
   * @param {any} res
   * @returns {string}
   */
  function extractTextFromResponse(res) {
    if (!res) return '';
    if (typeof res === 'string') return res;
    if (typeof res.output_text === 'string') return res.output_text;
    const first = Array.isArray(res.output) && res.output[0];
    const content = first && Array.isArray(first.content) ? first.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string') return c.text;
      if (typeof c?.data === 'object') return JSON.stringify(c.data);
    }
    return '';
  }

  /**
   * Run the wallet analysis Responses job and normalize the envelope.
   * @param {{ merged: Object, model?: string, purpose?: string }} params
   * @returns {Promise<{ version: string, markdown: string, operator_summary?: Object }>}
   */
  async function analyzeWallet({ merged, model, purpose }) {
    if (!merged) {
      throw new Error('[walletDossier] missing merged payload');
    }

    let out;
    try {
      out = await runTask({
        task: 'walletDossier',
        payload: { merged, purpose },
        model,
      });
    } catch (err) {
      const text = extractTextFromResponse(err && err.response);
      out = { version: 'dossier.freeform.v1', markdown: String(text || '').trim() };
    }

    // If parsed but missing the expected envelope, wrap it
    if (!out || typeof out !== 'object' || !out.markdown) {
      const text = typeof out === 'string' ? out : JSON.stringify(out || {});
      out = { version: 'dossier.freeform.v1', markdown: String(text || '').trim() };
    }

    logger.debug('[walletDossier] model output (truncated):', JSON.stringify(out).slice(0, 300));
    const finalPayload = buildFinalPayload({ prompt: merged, response: out });
    await queueVectorStoreUpload({
      source: 'dossier',
      name: merged?.meta?.traderName || merged?.meta?.wallet || null,
      data: finalPayload,
    }).catch((err) => logger.warn('[walletDossier] vector store ingest failed:', err?.message));
    return out;
  }

  return { analyzeWallet };
}

// Default instance using the shared client for convenience / backward compatibility.
const { analyzeWallet } = createWalletAnalysis(defaultClient);

module.exports = {
  createWalletAnalysis,
  analyzeWallet
};
