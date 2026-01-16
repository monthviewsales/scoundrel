// ai/client.js
'use strict';

  require("dotenv").config({ quiet: true });
  const OpenAI = require('openai');
  const log = require('../lib/log');

  // Default to the latest Grok model for xAI Responses.
  const DEFAULT_MODEL = 'grok-4-1-fast-reasoning';
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;
  const xAIApiKey = process.env.xAI_API_KEY || (isTestEnv ? 'test' : undefined);

  const client = new OpenAI({ 
    apiKey: xAIApiKey,
    baseURL: 'https://api.x.ai/v1',
    timeout: 360000,
  });

/**
 * Call xAI Responses API with Structured Outputs.
 * @param {Object} opts
 * @param {Object} opts.schema - JSON Schema for structured outputs
 * @param {string} [opts.name='scoundrel_job'] - Schema name
 * @param {string} [opts.system] - Optional system-level instructions
 * @param {string|Object} [opts.user] - User content or JSON payload (will be JSON.stringified if object)
 * @param {Array|String} [opts.input] - Optional prebuilt input list or string (overrides system/user)
 * @param {string} [opts.model=DEFAULT_MODEL] - Model name, e.g. 'grok-4-1-fast-reasoning'
 * @param {number} [opts.temperature] - Optional temperature; only sent if explicitly provided
 * @param {string|{id:string,version?:string}} [opts.prompt] - Dashboard Prompt id or { id, version }
 * @param {Object} [opts.reasoning] - Optional reasoning config (if supported by the model)
 * @param {Object} [opts.metadata] - Optional metadata to send with the request
 * @param {...any} [extra] - Additional options (except unsupported ones like `seed`)
 */
async function callResponses({
  schema,
  name = 'scoundrel_job',
  system,
  user,
  input,
  model = DEFAULT_MODEL,
  temperature,
  prompt,
  reasoning,
  metadata,
  ...extra
}) {
  let resolvedInput = input;
  if (!resolvedInput) {
    resolvedInput = [];
    if (typeof system === 'string' && system.trim().length) {
      resolvedInput.push({ role: 'system', content: system });
    }
    const userContent = (typeof user === 'string')
      ? user
      : JSON.stringify(user ?? {});
    resolvedInput.push({ role: 'user', content: userContent });
  }

  // Responses API structured outputs live under text.format, not response_format
  const payload = {
    model,
    input: resolvedInput,
    text: {
      format: {
        type: 'json_schema',
        name,
        schema,
        strict: true,
      },
    },
  };

  // Some latest / reasoning models don't support temperature.
  // Only include it if the caller explicitly set a number.
  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  if (reasoning && typeof reasoning === 'object') {
    payload.reasoning = reasoning;
  }

  if (metadata && typeof metadata === 'object') {
    payload.metadata = metadata;
  }

  // If a Dashboard Prompt id or object is provided, include it.
  if (prompt) {
    payload.prompt = typeof prompt === 'string' ? { id: prompt } : prompt;
  }

  // Filter out unsupported extras like `seed` to avoid 400s.
  if (extra && Object.keys(extra).length) {
    const { seed, ...rest } = extra;
    if (typeof seed !== 'undefined') {
      log.warn('[ai:client] Ignoring unsupported `seed` parameter for Responses API; remove it at call sites if possible.');
    }
    Object.assign(payload, rest);
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
  if (!res.output_text) log.warn('[ai:client] output_text empty; falling back to manual parse of content blocks');
  const outputs = Array.isArray(res.output) ? res.output : [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string') { try { return JSON.parse(c.text); } catch (_) {} }
      if (typeof c?.data === 'object') return c.data;
    }
  }
  throw new Error('[ai:client] Could not parse JSON from Responses output');
}

module.exports = { callResponses, parseResponsesJSON, log };
