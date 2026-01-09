'use strict';

const ASK_V1_SCHEMA = {
  name: 'ask_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string' },
      bullets: {
        type: 'array',
        items: { type: 'string' },
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['answer', 'bullets', 'actions'],
  },
};

const SYSTEM = [
  'You are Scoundrel, a Solana trading assistant.',
  'Answer the user concisely and practically.',
  'Use ONLY the JSON provided (profile + optional rows) as context; do not invent facts.',
  'Return JSON that matches the schema exactly (answer + bullets + actions). If there are no bullets or actions, return empty arrays. No prose outside JSON.',
].join(' ');

/**
 * Build the user payload for the ask task.
 * @param {{ profile?: Object, question?: string, rows?: Array }} payload
 * @returns {{ question: string, profile: Object|null, rows: Array|null }}
 */
function buildUser(payload) {
  const safePayload = payload || {};
  return {
    question: safePayload.question,
    profile: safePayload.profile || null,
    rows: Array.isArray(safePayload.rows) ? safePayload.rows.slice(0, 200) : null,
  };
}

module.exports = {
  name: ASK_V1_SCHEMA.name,
  schema: ASK_V1_SCHEMA.schema,
  system: SYSTEM,
  buildUser,
};
