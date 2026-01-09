// lib/ask.js
// Processor for "ask" CLI command — uses the Responses-first AI client.
// Exports a default async function that returns a plain string answer.

require('../env/safeDotenv').loadDotenv();
const { runTask } = require('../../ai/warlordAI');
const BootyBox = require('../../db');
const { requestId } = require('../id/issuer');
const logger = require('../logger');

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
  const q = question.trim().replace(/\s+/g, ' ');

  const user = {
    question: q,
    profile: profile || null,
    rows: Array.isArray(rows) ? rows.slice(0, 200) : null
  };

  const model = process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.2';
  // Generate an ask_id via the event-driven ULID issuer
  const askIdRaw = await requestId({ prefix: 'ask' });
  const askId = String(askIdRaw).slice(-26);

  const out = await runTask({
    task: 'ask',
    payload: user,
    model,
  });
  if (process.env.NODE_ENV === 'development') {
    logger.debug('[ask] model output:', out);
  }

  try {
    await BootyBox.init();
    await BootyBox.recordAsk({
      askId,
      correlationId: askId,
      question: q,
      profile: user.profile,
      rows: user.rows,
      model,
      temperature: null,
      responseRaw: out,
      answer: out.answer || '',
      bullets: out.bullets,
      actions: out.actions,
    });
    if (process.env.NODE_ENV === 'development') {
      logger.info(`[ask] persisted ask ${askId}`);
      if (process.env.NODE_ENV === 'development') {
        logger.info(`[ask] id: ${askId}`);
      }
    }
  } catch (dbErr) {
    logger.warn('[ask] failed to persist ask:', dbErr.message || dbErr);
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
