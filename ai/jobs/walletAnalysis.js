// ai/jobs/walletAnalysis.js
const { callResponses, parseResponsesJSON, log } = require('../client');
const schema = require('../schemas/walletAnalysis.v1.schema.json');

const SYSTEM = [
  'You are a Solana wallet analyst.',
  'Analyze only the JSON the user provides (trades + chart).',
  'Return JSON that matches the schema exactly—no prose.'
].join(' ');

async function analyzeWallet({ merged, model, purpose }) {
  if (!merged || !merged.meta || !merged.trades) {
    throw new Error('[walletAnalysis] merged payload must include {meta, trades[, chart]}');
  }

  const res = await callResponses({
    schema, name: 'wallet_analysis_v1', system: SYSTEM,
    user: { purpose: purpose || 'Analyze this wallet.', merged },
  });

  const out = parseResponsesJSON(res);
  log.debug('[walletAnalysis] model output (truncated):', JSON.stringify(out).slice(0, 300));

  return out;
}

module.exports = { analyzeWallet };