// ai/jobs/walletAnalysis.js
const { callResponses, parseResponsesJSON, log } = require('../client');
const schema = require('../schemas/walletAnalysis.v1.schema.json');

const SYSTEM = [
  'You are Scoundrel, an expert Solana wallet analyst for high-velocity memecoin trading.',
  'Goal: Return JSON that matches the provided schema EXACTLY. Do not add extra fields.',
  'Within the existing fields, surface actionable alpha:',
  '- In `summary`: a one-sentence thesis on this wallet\'s edge and how to replicate it.',
  '- In `behavior.notes`: 4–6 tightly written, actionable bullets focused on execution: when this wallet is active/profitable (UTC ranges), typical trade lifecycle (entry→add→exit) and hold-time hints, liquidity bands they favor, venue/route preferences, what to copy vs. what to ignore.',
  '- In `top_mints`: choose the most meaningful mints by recent volume or trade count; set `estPnLUsd` if inferable.',
  '- In `timeline[].note`: add a short tactical takeaway for that event (e.g., "exit on 1.5x with tight trail", "avoid thin books < $50k liq").',
  '- In `risks`: concrete failure modes (thin liquidity, frontrun risk, copy-trade lag, fake pumps).',
  'Rules: Use ONLY the provided JSON (trades + chart). If a value is not derivable, set it to null or an empty list as allowed by the schema. Be concise and prioritize information that directly improves PnL or reduces risk. Output must be valid JSON per the schema; no prose outside JSON.'
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