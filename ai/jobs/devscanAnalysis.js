'use strict';

const defaultClient = require('../grokClient');
const devscanTask = require('../warlordAI/tasks/devscanAnalysis');
const { createWarlordAI } = require('../warlordAI');

/**
 * Create a DevScan analysis runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeDevscan: (args: { payload: Object, model?: string, purpose?: string }) => Promise<Object> }}
 */
function createDevscanAnalysis(client) {
  const resolvedClient = client || defaultClient;
  const { runTask } = createWarlordAI({
    clients: { grok: resolvedClient },
    defaultProvider: 'grok',
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

  function buildFallback(version, payload) {
    if (version === 'devscan.mint.v1') {
      const target = payload?.meta?.mint || payload?.token?.data?.mintAddress || null;
      return {
        version,
        markdown: '',
        entity_type: 'mint',
        target,
        mint: {
          address: target,
          symbol: null,
          name: null,
          status: null,
          createdAt: null,
          priceUsd: null,
          marketCapUsd: null,
          migrated: null,
          creatorWallet: null,
          launchPlatform: null,
        },
        developer: null,
        x_mentions: {
          query: target,
          last_60m: null,
          last_30m: null,
          last_5m: null,
          top_accounts: [],
          notes: 'x_search unavailable or no results.',
        },
        x_profiles: [],
        highlights: [],
        risk_flags: [],
        confidence: 0,
      };
    }

    const target = payload?.meta?.developerWallet || payload?.meta?.developerTokensWallet || null;
    return {
      version,
      markdown: '',
      entity_type: 'developer',
      target,
      developer: {
        wallet: target,
        name: null,
        rating: null,
        totalTokensCreated: null,
        migrationCount: null,
        feesCollected: null,
        x_handles: [],
      },
      tokens_summary: {
        total: 0,
        alive: 0,
        dead: 0,
        migrated: 0,
        top_market_caps: [],
        recent_mints: [],
      },
      x_profiles: [],
      x_mints_mentioned: [],
      highlights: [],
      risk_flags: [],
      confidence: 0,
    };
  }

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

    const { version } = devscanTask.resolve({ payload });
    let out;
    try {
      out = await runTask({
        task: 'devscanAnalysis',
        payload: { payload, purpose },
        model,
      });
    } catch (e) {
      const text = extractTextFromResponse(e && e.response);
      out = buildFallback(version, payload);
      out.markdown = String(text || '').trim();
    }

    if (!out || typeof out !== 'object' || !out.markdown) {
      const text = typeof out === 'string' ? out : JSON.stringify(out || {});
      out = buildFallback(version, payload);
      out.markdown = String(text || '').trim();
    }
    logger.debug('[devscanAnalysis] model output (truncated):', JSON.stringify(out).slice(0, 300));
    return out;
  }

  return { analyzeDevscan };
}

const { analyzeDevscan } = createDevscanAnalysis(defaultClient);

module.exports = {
  createDevscanAnalysis,
  analyzeDevscan,
};
