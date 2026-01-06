'use strict';

const defaultClient = require('../grokClient');
const profileScoreSchema = require('../schemas/grok.x_profile_score.v1.schema.json');

const SYSTEM = [
  'You are an X (Twitter) intel analyst scoring a single profile.',
  'Use the x_search tool to gather recent activity and context.',
  'Return ONLY JSON that matches the schema; no markdown.',
  'Score is a raw 0–100 value (not a percentage).',
  'If the score is <10 it is NOT elite; reserve "elite" for 85+.',
  'If you cannot get time-windowed activity counts, set them to null and explain why in x_activity.notes.'
].join(' ');

/**
 * Create a Grok profile scoring runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ runGrokProfileScore: (args: { handle: string, profileUrl?: string, profile?: Object, model?: string, purpose?: string }) => Promise<Object> }}
 */
function createGrokProfileScore(client) {
  const { callResponses, parseResponsesJSON, log } = client || defaultClient;
  const logger = log || console;

  async function runGrokProfileScore({ handle, profileUrl, profile, model, purpose }) {
    if (!handle || typeof handle !== 'string') {
      throw new Error('[grokProfileScore] handle is required');
    }

    const user = {
      handle: handle.replace(/^@/, ''),
      profileUrl: profileUrl || null,
      profile: profile || null,
      purpose: purpose || 'Score the profile based on activity, credibility, and signal quality.',
    };

    const res = await callResponses({
      system: SYSTEM,
      model,
      name: 'grok_x_profile_score_v1',
      schema: profileScoreSchema,
      user,
      temperature: 0.2,
      tools: [{ type: 'x_search' }],
      tool_choice: 'auto',
    });

    const out = parseResponsesJSON(res);
    logger.debug('[grokProfileScore] model output (truncated):', JSON.stringify(out).slice(0, 256));
    return out;
  }

  return { runGrokProfileScore };
}

const { runGrokProfileScore } = createGrokProfileScore(defaultClient);

module.exports = {
  createGrokProfileScore,
  runGrokProfileScore,
};
