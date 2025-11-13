// ai/client.js
'use strict';

require('dotenv').config();
const OpenAI = require('openai');
const log = require('../lib/log');

/**
 * Resolve a required environment variable.
 * @param {string} key
 * @returns {string}
 */
function requireEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error(`[ai:client] Missing ${key}`);
  return value;
}

const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
const DEFAULT_MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';

/**
 * Call OpenAI Responses API with Structured Outputs.
 * @param {Object} opts
 * @param {Object} opts.schema - JSON Schema for structured outputs
 * @param {string} [opts.name='scoundrel_job'] - Schema name
 * @param {string} [opts.system] - System instructions (kept for compatibility)
 * @param {string|Object} [opts.user] - User content or JSON payload
 * @param {string} [opts.model=DEFAULT_MODEL]
 * @param {number} [opts.temperature=0.1]
 * @param {string|{id:string,version?:string}} [opts.prompt] - Dashboard Prompt id or { id, version }
 */
async function callResponses({ schema, name = 'scoundrel_job', system, user, model = DEFAULT_MODEL, temperature = 0.1, prompt, ...extra }) {
  const input = [];
  if (typeof system === 'string' && system.trim().length) {
    input.push({ role: 'system', content: system });
  }
  const userContent = (typeof user === 'string') ? user : JSON.stringify(user ?? {});
  input.push({ role: 'user', content: userContent });

  const payload = {
    model,
    input,
    text: {
      format: {
        type: 'json_schema',
        name,
        schema,
        strict: true,
      },
    },
  };

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  // If a Dashboard Prompt id or object is provided, include it in the request
  if (prompt) {
    payload.prompt = typeof prompt === 'string' ? { id: prompt } : prompt;
  }

  // Spread any extra OpenAI options (e.g., top_p, seed)
  if (extra && Object.keys(extra).length) {
    Object.assign(payload, extra);
  }

  const res = await client.responses.create(payload);
  return res;
}

/**
 * Parse JSON output from a Responses API result.
 * @param {Object} res
 * @returns {Object}
 */
function parseResponsesJSON(res) {
  if (!res) throw new Error('[ai:client] Empty response');
  if (res.output_text) return JSON.parse(res.output_text);
  const first = Array.isArray(res.output) && res.output[0];
  const content = first && Array.isArray(first.content) ? first.content : [];
  if (!res.output_text) log.warn('[ai:client] output_text empty; falling back to manual parse of content blocks');
  for (const c of content) {
    if (typeof c?.text === 'string') { try { return JSON.parse(c.text); } catch (_) {} }
    if (typeof c?.data === 'object') return c.data;
  }
  throw new Error('[ai:client] Could not parse JSON from Responses output');
}

module.exports = { callResponses, parseResponsesJSON, log };