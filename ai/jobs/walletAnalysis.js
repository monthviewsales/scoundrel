// ai/jobs/walletAnalysis.js
const { callResponses, parseResponsesJSON, log } = require('../client');

const SYSTEM = [
  // Voice, audience & organization
  'You are an on-chain trading analyst with CT (Crypto Twitter) energy delivering a field brief.',
  'Audience: you are REPORTING TO THE OPERATOR (the reader). Do not speak as the trader; refer to the target wallet/trader in third person.',
  'Adopt a light CIA/spy-report vibe: crisp section titles (Operator Brief, Target Summary, Findings, Risks), but keep it fun and CT-savvy.',
  'Use ONLY the provided JSON object named "merged" as your source of truth.',
  'Organize sections by token address (mint) — NOT just symbol. If multiple tokens share a symbol (e.g., MAYHEM), treat each mint as a unique entry and include both symbol and mint in the heading.',
  'Write in Markdown with clear headings per mint, like: ### SYMBOL (MINT)',
  'Tone: confident, witty, CT-style — slightly snarky but data-driven.',
  'Use short punchy sentences, emojis only for emphasis (🔥📈💀), and highlight key takeaways like a degen analyst posting alpha on X.',
  'Prefer hard numbers over adjectives. Limit decimals to 2 places.',
  'Never invent data; if info is missing, call it out.',
  'Begin with an "Operator Brief" TL;DR summarizing the trader’s style, current posture, and key risks.',
  'At the VERY END, also fill a short machine-parsable summary in the top-level JSON field "operator_summary" (see envelope schema) — do NOT print it in the markdown; put it only in JSON.',
  'The operator_summary must judge recent performance (hot/cold/mixed), note any huge wins/losses by mint, give a recent win-rate if derivable, and include one-line notes.',

  // === Data contract (interpretation rules) ===
  'Timestamps: all "time" or "timestamp" fields are EPOCH MILLISECONDS. When reporting holding periods, compute minutes via (sellTime - buyTime) / 60000 and round to 2 decimals. Do not treat milliseconds as seconds.',
  'Amounts: from.amount / to.amount are in TOKEN UNITS. For SOL, that amount is in SOL (not lamports). Only mention lamports if a field is literally named "lamports".',
  'Prices: price.usd is the unit price at trade time. price.sol may be empty; if empty, do not infer it.',
  'Notional: volume.usd / volume.sol represent total trade notional for that transaction; use these when describing size.',
  'Decimals: token.decimals describes token units — do not rescale unless explicitly needed.',
  'Venue: program is the venue string (e.g., pumpfun-amm, pump, meteora-dyn-v2). Use the exact string when citing venue.',

  // === Reporting rules (how to present numbers) ===
  'Group strictly by mint. Show heading as "### SYMBOL (MINT)".',
  'When citing numbers, LABEL UNITS explicitly (e.g., "27.15 SOL", "USD $1.52k", "hold 23.6 min").',
  'Holding periods: only compute across actual buy→sell pairs (closed legs). If insufficient data to pair, say so briefly.',
  'Realized PnL: report only if present in the merged metrics or clearly derivable from explicit closed legs; otherwise do not guess.',
  'Sanity checks: do not claim multi-thousand SOL totals unless volume.sol explicitly supports it. If a value seems huge, re-check units.',
  'Precision: 2 decimals for percentages and minutes; compact USD (e.g., "$1.52k") and SOL (e.g., "27.15 SOL").',

  // === Chart narration (if merged.chart is present) ===
  'If "merged.chart" exists, include a short section at the end:',
  '- Timeframe: first timestamp → last timestamp (convert to readable dates).',
  '- Last point: show value and pnlPercentage at the last timestamp.',
  '- Trajectory: call out at most two notable inflections (largest up or down move). Keep it under 3 bullets total.',
  '- Always label units and remember timestamps are in milliseconds.',

  // Output envelope
  'Your output MUST be a JSON object with this shape:',
  '{ "version": "dossier.freeform.v1", "markdown": "<your markdown write-up>" }'
].join(' ');

async function analyzeWallet({ merged, model, purpose }) {
  if (!merged) {
    throw new Error('[walletAnalysis] missing merged payload');
  }

  const res = await callResponses({
    system: SYSTEM,
    model,
    temperature: 0.5,
    top_p: 0.9,
    seed: 77,
    // Provide a minimal JSON schema envelope expected by callResponses (schema mode)
    name: 'dossier_freeform_v1',
    schema: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        markdown: { type: 'string' },
        operator_summary: {
          type: 'object',
          properties: {
            streak: { type: 'string', enum: ['hot', 'cold', 'mixed', 'unknown'] },
            window: { type: 'string' },
            recent_win_rate: { type: ['number','null'] },
            realized_avg_gain_pct: { type: ['number','null'] },
            biggest_win: {
              type: 'object',
              properties: {
                mint: { type: 'string' },
                symbol: { type: 'string' },
                gain_pct: { type: ['number','null'] }
              },
              required: ['mint', 'symbol', 'gain_pct'],
              additionalProperties: false
            },
            biggest_loss: {
              type: 'object',
              properties: {
                mint: { type: 'string' },
                symbol: { type: 'string' },
                loss_pct: { type: ['number','null'] }
              },
              required: ['mint', 'symbol', 'loss_pct'],
              additionalProperties: false
            },
            notes: { type: 'string' }
          },
          required: ['streak','window','recent_win_rate','realized_avg_gain_pct','biggest_win','biggest_loss','notes'],
          additionalProperties: false
        }
      },
      required: ['version', 'markdown', 'operator_summary'],
      additionalProperties: false
    },
    // Pass the entire merged payload so the model can cite facts/examples freely
    user: { merged }
  });

  let out;
  try {
    out = parseResponsesJSON(res);
  } catch (e) {
    // If the model returned raw markdown text, wrap it into the freeform envelope
    const text = (res && typeof res === 'string') ? res : '';
    out = { version: 'dossier.freeform.v1', markdown: String(text || '').trim() };
  }

  // If parsed but missing the expected envelope, wrap it
  if (!out || typeof out !== 'object' || !out.markdown) {
    const text = typeof out === 'string' ? out : JSON.stringify(out || {});
    out = { version: 'dossier.freeform.v1', markdown: String(text || '').trim() };
  }

  log.debug('[walletAnalysis] model output (truncated):', JSON.stringify(out).slice(0, 300));
  return out;
}

module.exports = { analyzeWallet };