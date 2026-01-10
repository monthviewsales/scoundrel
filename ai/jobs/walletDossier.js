'use strict';

// ai/jobs/walletDossier.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const defaultClient = require('../gptClient');
const { createWarlordAI } = require('../warlordAI');
const { buildFinalPayload } = require('../../lib/analysis/payloadBuilders');

// Vector store that will hold dossier responses. Override via env when needed.
const DOSSIER_VECTOR_STORE_ID = process.env.DOSSIER_VECTOR_STORE_ID || 'vs_695c1a78e9f48191a718f1ba937e5c88';


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

  async function saveAnalysisToVectorStore({ analysis, merged }) {
    if (!DOSSIER_VECTOR_STORE_ID) {
      logger.warn('[walletDossier] Missing vector store id; skipping vector store ingest');
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('[walletDossier] OPENAI_API_KEY missing; skipping vector store ingest');
      return;
    }
    const finalPayload = buildFinalPayload({ prompt: merged, response: analysis });
    const content = JSON.stringify(finalPayload);
    const tmpPath = path.join(os.tmpdir(), `dossier-${randomUUID()}.json`);
    try {
      logger.warn('[walletDossier] Ingesting dossier into vector store', { vectorStore: DOSSIER_VECTOR_STORE_ID });
      await fs.promises.writeFile(tmpPath, content, 'utf8');
      const openai = new OpenAI({ apiKey });
      const file = await openai.files.create({
        file: fs.createReadStream(tmpPath),
        purpose: 'assistants'
      });
      logger.debug('[walletDossier] Uploaded file for vector store', { fileId: file.id });
      const vectorStores = openai.vectorStores || (openai.beta && openai.beta.vectorStores);
      if (!vectorStores) {
        throw new Error('Vector store API not available on OpenAI client');
      }
      if (vectorStores.fileBatches && typeof vectorStores.fileBatches.create === 'function') {
        await vectorStores.fileBatches.create(DOSSIER_VECTOR_STORE_ID, {
          file_ids: [file.id]
        });
      } else if (vectorStores.files && typeof vectorStores.files.create === 'function') {
        await vectorStores.files.create(DOSSIER_VECTOR_STORE_ID, {
          file_id: file.id
        });
      } else {
        throw new Error('Vector store attach API not available on OpenAI client');
      }
      logger.warn('[walletDossier] Stored analysis in vector store', { vectorStore: DOSSIER_VECTOR_STORE_ID, fileId: file.id });
    } catch (err) {
      logger.warn('[walletDossier] Failed to store analysis in vector store:', err.message);
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
    }
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

    // Persist into the configured OpenAI vector store (wait to ensure upload completes).
    await saveAnalysisToVectorStore({ analysis: out, merged })
      .catch((err) => logger.warn('[walletDossier] vector store ingest failed:', err?.message));
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
