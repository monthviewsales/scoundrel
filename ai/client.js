// ai/client.js
require('dotenv').config();
const OpenAI = require('openai');
const log = require('../lib/log');

function requireEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`[ai:client] Missing ${k}`);
  return v;
}

const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
const DEFAULT_MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';

async function callResponses({ schema, name = 'scoundrel_job', system, user, model = DEFAULT_MODEL, temperature = 0.1 }) {
  const input = [
    { role: 'system', content: system },
    { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
  ];
  const res = await client.responses.create({
    model,
    input,
    text:{
        format:{
            type: 'json_schema',
            name,
            schema,
            strict: true,
        },
    },
    // temperature,
  });
  return res;
}

function parseResponsesJSON(res) {
  if (!res) throw new Error('[ai:client] Empty response');
  if (res.output_text) return JSON.parse(res.output_text);
  const first = Array.isArray(res.output) && res.output[0];
  const content = first && Array.isArray(first.content) ? first.content : [];
  for (const c of content) {
    if (typeof c?.text === 'string') { try { return JSON.parse(c.text); } catch (_) {} }
    if (typeof c?.data === 'object') return c.data;
  }
  throw new Error('[ai:client] Could not parse JSON from Responses output');
}

module.exports = { callResponses, parseResponsesJSON, log };