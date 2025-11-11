// ai/jobs/walletAnalysis.js
const { callResponses, parseResponsesJSON, log } = require('../client');
const schema = require('../schemas/walletAnalysis.v3.schema.json');

// If you’ve saved the Dashboard Prompt, paste its id below.
// You can override via env OPENAI_PROMPT_ID if you prefer not to hardcode.
const PROMPT_ID = 'pmpt_69127f39f93081908453beb8aea5713e083828843fb7c044';

const SYSTEM = [
  'You are Scoundrel, a Solana memecoin wallet behavior analyst. Output MUST be valid JSON matching the provided schema EXACTLY (no extra fields).',
  'You receive a single object: { features } where features = { coins:[...], overall:{...} } computed upstream from the last 5 mints. Do NOT re-summarize raw trades. Infer technique from the provided statistics only.',
  'Rules:',
  ' • If median holds are short (<60m) with frequent rotations → style="scalper"; if multi-hour/day holds → style="swing"; otherwise "unknown".',
  ' • If buys are clustered in short windows → entryTechnique="scale_in"; if spacing is very even across ≥3 buys → "twap"; if consistent periodic spacing across long windows → "dca"; single buy → "single_shot".',
  ' • avgExitGainPct should reflect typical realized gains (use features.overall.avgRealizedGainPct when available). If unavailable, set null.',
  ' • typicalMarketCapRange is unknown unless features provide it; set "unknown".',
  ' • exitTrigger: prefer "profit_target" when realized gains cluster; use "time_stop" for long holds with flat gains; otherwise "unknown".',
  'Return only the JSON defined by the schema.'
].join(' ');

async function analyzeWallet({ merged, model, purpose }) {
  if (!merged || !merged.techniqueFeatures) {
    throw new Error('[walletAnalysis] missing merged.techniqueFeatures');
  }

  const usePrompt = PROMPT_ID && !/REPLACE_ME/.test(PROMPT_ID);

  const features = merged && merged.techniqueFeatures ? merged.techniqueFeatures : null;
  if (!features) throw new Error('[walletAnalysis] missing merged.techniqueFeatures');

  const res = await callResponses({
    schema,
    name: 'wallet_analysis_v3',
    // Prefer Dashboard Prompt; fall back to inline SYSTEM for local/dev
    ...(usePrompt ? { prompt: { id: PROMPT_ID } } : { system: SYSTEM }),
    user: { features },
  });

  const out = parseResponsesJSON(res);
  log.debug('[walletAnalysis] model output (truncated):', JSON.stringify(out).slice(0, 300));

  return out;
}

module.exports = { analyzeWallet };