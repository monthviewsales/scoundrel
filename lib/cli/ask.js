// lib/ask.js
// Processor for "ask" CLI command — uses the Responses-first AI client.
// Exports a default async function that returns a plain string answer.

require('../env/safeDotenv').loadDotenv();
const { runTask } = require('../../ai/warlordAI');
const { searchVectorStore } = require('../ai/vectorStoreSearch');
const BootyBox = require('../../db');
const { requestId } = require('../id/issuer');
const logger = require('../logger');

function toBoolEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function compactSearchResults(results, maxResults = 8, maxChars = 900) {
  const list = Array.isArray(results) ? results : [];
  return list.slice(0, maxResults).map((row) => {
    const content = Array.isArray(row.content)
      ? row.content
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    return {
      file_id: row.file_id || null,
      filename: row.filename || null,
      score: typeof row.score === 'number' ? row.score : null,
      attributes: row.attributes || null,
      content: content.length > maxChars ? content.slice(0, maxChars) : content,
    };
  });
}

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
  const explicitRag = toBoolEnv(process.env.ASK_EXPLICIT_RAG || process.env.WARLORDAI_EXPLICIT_RAG);
  const isStrategyQuestion = /\b(strategy|plan|approach|playbook|setup)\b/i.test(q);
  let sources = null;
  if (explicitRag && isStrategyQuestion) {
    const vectorStoreId = process.env.WARLORDAI_VECTOR_STORE;
    if (!vectorStoreId) {
      logger.warn('[ask] explicit RAG requested but WARLORDAI_VECTOR_STORE is not set');
    } else {
      try {
        const results = await searchVectorStore({
          vectorStoreId,
          query: q,
          maxResults: 8,
          filters: {
            type: 'in',
            key: 'source',
            value: ['dossier', 'autopsy'],
          },
          rewriteQuery: true,
        });
        sources = compactSearchResults(results, 8, 900);
      } catch (err) {
        logger.warn('[ask] explicit RAG search failed:', err?.message || err);
      }
    }
  }

  const user = {
    question: q,
    profile: profile || null,
    rows: Array.isArray(rows) ? rows.slice(0, 200) : null,
    sources,
  };

  const model = process.env.OPENAI_RESPONSES_MODEL || 'gpt-5-mini';
  // Generate an ask_id via the event-driven ULID issuer
  const askIdRaw = await requestId({ prefix: 'ask' });
  const askId = String(askIdRaw).slice(-26);

  const out = await runTask({
    task: 'ask',
    payload: user,
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
