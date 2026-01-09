'use strict';

const profileScoreSchema = require('../../schemas/grok.x_profile_score.v1.schema.json');

const SYSTEM = [
  'You are an X (Twitter) intel analyst scoring a single profile.',
  'Use the x_search tool to gather recent activity and context.',
  'Return ONLY JSON that matches the schema; no markdown.',
  'Score is a raw 0–100 value (not a percentage).',
  'If the score is <10 it is NOT elite; reserve "elite" for 85+.',
  'If you cannot get time-windowed activity counts, set them to null and explain why in x_activity.notes.'
].join(' ');

/**
 * Build the user payload for a Grok profile score task.
 * @param {{ handle: string, profileUrl?: string, profile?: Object, purpose?: string }} payload
 * @returns {{ handle: string, profileUrl: string|null, profile: Object|null, purpose: string }}
 */
function buildUser(payload) {
  const safePayload = payload || {};
  if (!safePayload.handle || typeof safePayload.handle !== 'string') {
    throw new Error('[grokProfileScore] handle is required');
  }

  return {
    handle: safePayload.handle.replace(/^@/, ''),
    profileUrl: safePayload.profileUrl || null,
    profile: safePayload.profile || null,
    purpose: safePayload.purpose || 'Score the profile based on activity, credibility, and signal quality.',
  };
}

module.exports = {
  name: 'grok_x_profile_score_v1',
  schema: profileScoreSchema,
  system: SYSTEM,
  provider: 'grok',
  temperature: 0.2,
  tools: [{ type: 'x_search' }],
  tool_choice: 'auto',
  buildUser,
};
