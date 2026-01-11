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
  'Use ONLY the JSON provided (profile, rows, and optional history) as context; do not invent facts.',
  'When needed, call file_search to retrieve relevant dossiers, autopsies, or target scans from the vector store.',
  'Use file search and your tools for additional information when needed.',
  'If history is provided, treat it as prior Q/A context for follow-ups.',
  'Return JSON that matches the schema exactly (answer + bullets + actions). If there are no bullets or actions, return empty arrays. No prose outside JSON.',
].join(' ');

/**
 * Build the user payload for the ask task.
 * @param {{ profile?: Object, question?: string, rows?: Array, history?: Array }} payload
 * @returns {{ question: string, profile: Object|null, rows: Array|null, history: Array|null, tooling: Object }}
 */
function buildUser(payload) {
  const safePayload = payload || {};
  return {
    question: safePayload.question,
    profile: safePayload.profile || null,
    rows: Array.isArray(safePayload.rows) ? safePayload.rows.slice(0, 200) : null,
    history: Array.isArray(safePayload.history) ? safePayload.history.slice(0, 20) : null,
    tooling: {
      file_search: 'Search the WarlordAI vector store for dossiers, autopsies, and target scans.',
      local_tools: [
        'solanaTrackerData.getWalletTrades: wallet trades for a time window.',
        'solanaTrackerData.getTokenSnapshotNow: token overview + pricing now.',
        'solanaTrackerData.getTokenRiskScores: token risk flags and factors.',
        'solanaTrackerData.getPriceRange: token price range for a time window.',
      ],
    },
  };
}

module.exports = {
  name: ASK_V1_SCHEMA.name,
  schema: ASK_V1_SCHEMA.schema,
  system: SYSTEM,
  enableRag: true,
  ragMaxResults: 8,
  buildUser,
};
