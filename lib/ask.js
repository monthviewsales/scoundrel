// lib/ask.js
// Processor for "ask" CLI command — uses the Responses-first AI client.
// Exports a default async function that returns a plain string answer.

require('dotenv').config();
const { callResponses, parseResponsesJSON, log } = require('../ai/client');
const { query } = require('../db/mysql');
const { requestId } = require('../id/issuer');

// Keep schema tiny and strict to avoid validator warnings
const ASK_V1_SCHEMA = {
  name: 'ask_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string' },
      bullets: {
        type: 'array',
        items: { type: 'string' }
      },
      actions: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['answer', 'bullets', 'actions']
  }
};

const SYSTEM = [
  'You are Scoundrel, a Solana trading assistant.',
  'Answer the user concisely and practically.',
  'Use ONLY the JSON provided (profile + optional rows) as context; do not invent facts.',
  'Return JSON that matches the schema exactly (answer + bullets + actions). If there are no bullets or actions, return empty arrays. No prose outside JSON.'
].join(' ');

/**
 * @param {Object} args
 * @param {Object} [args.profile] - Trader profile JSON (may be undefined)
 * @param {string} args.question   - Natural language question from the user
 * @param {Array}  [args.rows]     - Optional recent trade rows or analysis rows
 * @returns {Promise<string>}      - Plain string answer
 */
module.exports = async function askProcessor({ profile, question, rows }) {
  if (!question || typeof question !== 'string') {
    throw new Error('[ask] question (string) is required');
  }

  const user = {
    question,
    profile: profile || null,
    rows: Array.isArray(rows) ? rows.slice(0, 200) : null
  };

  const model = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';
  const temperature = 0.2;
  // Generate an ask_id via the event-driven ULID issuer
  const askId = await requestId({ prefix: 'ask' });

  const res = await callResponses({
    schema: ASK_V1_SCHEMA.schema, // pass the JSON Schema object, not the wrapper
    name: ASK_V1_SCHEMA.name,
    system: SYSTEM,
    user,
    model,
    temperature,
  });

  const out = parseResponsesJSON(res);
  if (process.env.NODE_ENV === 'development') {
    log.debug('[ask] model output:', out);
  }

  try {
    await query(
      `INSERT INTO sc_asks (
        ask_id, correlation_id, question, profile, rows, model, temperature, response_raw, answer, bullets, actions
      ) VALUES (
        :ask_id, :correlation_id, :question, CAST(:profile AS JSON), CAST(:rows AS JSON), :model, :temperature, CAST(:response_raw AS JSON), :answer, CAST(:bullets AS JSON), CAST(:actions AS JSON)
      )`,
      {
        ask_id: askId,
        correlation_id: askId, // using askId for correlation tracing
        question,
        profile: JSON.stringify(user.profile),
        rows: JSON.stringify(user.rows),
        model,
        temperature,
        response_raw: JSON.stringify(res),
        answer: out.answer || '',
        bullets: JSON.stringify(Array.isArray(out.bullets) ? out.bullets : []),
        actions: JSON.stringify(Array.isArray(out.actions) ? out.actions : [])
      }
    );
    if (process.env.NODE_ENV === 'development') {
      log.info(`[ask] persisted ask ${askId}`);
    }
  } catch (dbErr) {
    log.warn && log.warn('[ask] failed to persist ask:', dbErr.message || dbErr);
  }

  let result = out.answer || '';
  if (Array.isArray(out.bullets) && out.bullets.length) {
    result += '\n\n• ' + out.bullets.join('\n• ');
  }
  if (Array.isArray(out.actions) && out.actions.length) {
    result += '\n\nNext actions:\n- ' + out.actions.join('\n- ');
  }
  return result.trim();
};