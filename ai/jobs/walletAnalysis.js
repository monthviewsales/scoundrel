// ai/jobs/walletAnalysis.js
const { callResponses, parseResponsesJSON, log } = require('../client');
const schema = require('../schemas/walletAnalysis.v3.schema.json');
const { summarizeForSidecar } = require('../../lib/analysis/chartSummarizer');

// If you’ve saved the Dashboard Prompt, paste its id below.
// You can override via env OPENAI_PROMPT_ID if you prefer not to hardcode.
const PROMPT_ID = 'pmpt_69127f39f93081908453beb8aea5713e083828843fb7c044';

const SYSTEM = [
'You\'re my blockchain financial analyst.  I\'ll be sending you JSON based trading intel on some of the biggest public traders on Solana.',
'Review the data in these reports to build a trading profile to help me understand their style and strategies and gain an edge over them.'
].join(' ');

async function analyzeWallet({ merged, model, purpose }) {
  if (!merged || !merged.techniqueFeatures) {
    throw new Error('[walletAnalysis] missing merged.techniqueFeatures');
  }

  const usePrompt = PROMPT_ID && !/REPLACE_ME/.test(PROMPT_ID);

  const features = merged && merged.techniqueFeatures ? merged.techniqueFeatures : null;
  if (!features) throw new Error('[walletAnalysis] missing merged.techniqueFeatures');

  const chartBlocks = merged && merged.chart ? summarizeForSidecar(merged.chart) : { wallet_performance: [], wallet_curve: {} };

  const res = await callResponses({
    schema,
    name: 'wallet_analysis_v3',
    // Prefer Dashboard Prompt; fall back to inline SYSTEM for local/dev
    ...(usePrompt ? { prompt: { id: PROMPT_ID } } : { system: SYSTEM }),
    user: {
      features,
      wallet_performance: chartBlocks.wallet_performance,
      wallet_curve: chartBlocks.wallet_curve
    },
  });

  const out = parseResponsesJSON(res);
  log.debug('[walletAnalysis] model output (truncated):', JSON.stringify(out).slice(0, 300));

  return out;
}

module.exports = { analyzeWallet };