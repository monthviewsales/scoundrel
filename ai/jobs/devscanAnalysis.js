'use strict';

const defaultClient = require('../grokClient');
const devscanSchema = require('../schemas/devscan.freeform.v1.schema.json');

const SYSTEM = [
  'You are a Solana memecoin intelligence analyst.',
  'You receive a JSON object named "payload" containing DevScan API responses.',
  'Your job is to summarize the token and/or developer data for a trading operator.',
  'Use ONLY the provided payload. Do not invent data.',
  'If a section is missing, explicitly say it is unavailable.',
  'If a section mentions a twitter or X profile for a dev or deployer tell me more abou the accounts views and followers.',
  'If the data is for a Solana memecoin and contains a mint address do a search for it on X and give me a report on how much and by who is mentioning it.',
  'Return concise, structured Markdown with clear headings.',
  'Include a short risks section if any warnings or red flags appear in the data.',
  'At the end, fill the JSON summary field (see schema) without printing it in markdown.'
].join(' ');

const RESPONSE_SCHEMA = devscanSchema;

/**
 * Create a DevScan analysis runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeDevscan: (args: { payload: Object, model?: string, purpose?: string }) => Promise<Object> }}
 */
function createDevscanAnalysis(client) {
  const { callResponses, parseResponsesJSON, log } = client || defaultClient;

  /**
   * Run the DevScan Responses job and normalize the envelope.
   *
   * @param {{ payload: Object, model?: string, purpose?: string }} params
   * @returns {Promise<Object>}
   */
  async function analyzeDevscan({ payload, model, purpose }) {
    if (!payload) {
      throw new Error('[devscanAnalysis] missing payload');
    }

    const res = await callResponses({
      system: SYSTEM,
      model,
      name: 'devscan_freeform_v1',
      schema: RESPONSE_SCHEMA,
      user: { payload, purpose: purpose || 'Summarize the DevScan data for quick operator review.' },
      temperature: 0.3,
    });

    const fallbackSummary = {
      entity_type: 'unknown',
      target: 'unknown',
      highlights: [],
      risk_flags: [],
      confidence: 0,
    };

    let out;
    try {
      out = parseResponsesJSON(res);
    } catch (e) {
      const text = (res && typeof res === 'string') ? res : '';
      out = {
        version: 'devscan.freeform.v1',
        markdown: String(text || '').trim(),
        summary: fallbackSummary,
      };
    }

    if (!out || typeof out !== 'object' || !out.markdown) {
      const text = typeof out === 'string' ? out : JSON.stringify(out || {});
      out = {
        version: 'devscan.freeform.v1',
        markdown: String(text || '').trim(),
        summary: fallbackSummary,
      };
    }

    if (!out.summary || typeof out.summary !== 'object') {
      out.summary = fallbackSummary;
    }

    log.debug('[devscanAnalysis] model output (truncated):', JSON.stringify(out).slice(0, 300));
    return out;
  }

  return { analyzeDevscan };
}

const { analyzeDevscan } = createDevscanAnalysis(defaultClient);

module.exports = {
  createDevscanAnalysis,
  analyzeDevscan,
};
