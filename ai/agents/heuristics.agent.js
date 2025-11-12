/**
 * Heuristics Agent (tiny LLM)
 * Uses the OpenAI Responses API with a strict JSON schema to derive
 * strengths, weaknesses, patterns, and antiPatterns from { technique, outcomes }.
 * CommonJS only.
 */

const path = require('path');
const fs = require('fs');
const logBase = require('../../lib/log');
const log = {
  debug: (...a) => logBase.debug('[heuristics]', ...a),
  info:  (...a) => logBase.info('[heuristics]', ...a),
  warn:  (...a) => logBase.warn('[heuristics]', ...a),
  error: (...a) => logBase.error('[heuristics]', ...a),
};

const { callResponses } = require('../client');
const heuristicsSchema = require('../schemas/heuristics.v2.schema.json');

const MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';

const SYSTEM = [
  'You are a trading behavior analyst. Your job is to convert hard metrics into practical, testable heuristics.',
  'Use ONLY the provided JSON (technique, outcomes, and optional wallet context) as your source of truth.',
  'Return ONLY the JSON required by the heuristics.v2 schema (no prose, no extra fields).'
].join(' ');

function runId(){
  const d = new Date();
  const z = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3,'0')}`;
}

/**
 * @param {Object} opts
 * @param {Object} opts.technique - Output of technique (v3) stage
 * @param {Object} opts.outcomes  - Output of outcomes stage
 * @param {Array<Object>} [opts.wallet_performance] - Monthly PnL summary array
 * @param {Object} [opts.wallet_curve] - Curve stats block (dd/vol/streaks)
 * @param {string} [opts.analysisId] - Optional run identifier for artifact naming
 * @returns {Promise<{ strengths:string[], weaknesses:string[], patterns:string[], antiPatterns:string[] }>}
 */
async function inferHeuristics({ technique, outcomes, wallet_performance = [], wallet_curve = {}, analysisId = null }){
  if (!technique || !outcomes) {
    throw new Error('inferHeuristics: technique and outcomes are required');
  }

  const wp = Array.isArray(wallet_performance) ? wallet_performance : [];
  const wc = wallet_curve && typeof wallet_curve === 'object' ? wallet_curve : {};

  const user = { technique, outcomes, wallet_performance: wp, wallet_curve: wc };

  const res = await callResponses({
    schema: heuristicsSchema,
    name: 'heuristics_v2',
    model: MODEL,
    system: SYSTEM,
    user,
    temperature: 0.2,
  });

  // Dev artifact
  try {
    const outDir = path.join(process.cwd(), 'data');
    fs.mkdirSync(outDir, { recursive: true });
    const tag = analysisId ? `${analysisId}-` : '';
    fs.writeFileSync(path.join(outDir, `heuristics-v2-${tag}${runId()}.json`), JSON.stringify(res, null, 2));
  } catch (_) {}

  log.info('inferred heuristics');
  return res;
}

module.exports = { inferHeuristics };