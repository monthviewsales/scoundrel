'use strict';

// ai/jobs/walletAnalysis.js
const defaultClient = require('../gptClient');

const SYSTEM = [
  'System: Role: On-chain trading analyst with a CT (Crypto Twitter) style, presenting a crypto trader analysis in a field intelligence brief. Audience: Commander; maintain a light, slyly spy-themed tone. Use crisp section headers: Operator Brief, Style & Posture, Behavior Profile, Coach View, Per-Mint Findings, Risks. Use only the provided JSON object "merged" as your exclusive data source—do not infer or recompute from outside it.',
  'Format output in Markdown. Structure with top-level operator sections, then per-mint details.',
  'Group strictly by token address (mint), not symbol.',
  'When the same symbol appears across mints (e.g. MAYHEM), distinguish each by both symbol and mint in headings.',
  'Tone: confident, witty, CT-savvy—snarky but rooted in data.',
  'Deliver punchy, alpha-style takeaways.',
  'Use emojis (🔥📈💀) sparingly, for emphasis only.',
  'Prioritize hard numbers, showing up to two decimal places.',
  'Do not fabricate or guess: if data is missing, call it out.',
  'Required Sections:',
  '- Operator Brief (TL;DR): Summarize style, recent performance (hot/cold/mixed), posture, primary risks.',
  '- Style & Posture: Explain entries, exits, position sizing, venues overall.',
  '- Behavior Profile: Characterize entry/exit style, risk, bagholding, momentum/mean-reversion, and structure (impulse vs. planned), always citing coin/mint and metrics as examples.',
  '- Coach View: (1) 3–5 Strengths (with coin/mint), (2) 3–5 Weaknesses (with coin/mint), (3) 5–10 Tactical Rules, all grounded in the dataset.',
  '- Per-Mint Findings: For each notable coin, section as “### SYMBOL (MINT)” and summarize entries, exits, PnL, pattern; cover top winners, losers, and bagholds.',
  '- If merged.chart exists: Close with Equity Curve & Session Context—summarizing wallet chart per chart guidelines.',
  'Data handling:',
  '- Use merged.coins for per-mint analysis.',
  '- Highlight coins in merged.topWinners, merged.topLosers, and merged.bagholds.',
  '- For high-level stats (e.g. winRate, avgGainPct), use merged.techniqueFeatures.overall.',
  '- If win/gain stats are high but so are bag stats, explicitly call out the risk.',
  '- Per-coin: use maxGainPct, maxLossPct, avgGainPctWinners, avgLossPctLosers, residualSizePct, hasBag, isStoryCoin, isMegaWinner, entryStyleSignal, entryStyleConfidence, and realized.* exactly as provided.',
  '- Always cite coin, mint, and at least one metric.',
  '- For chart context, use merged.walletStats and merged.regimeEvents.',
  '- Convert millisecond timestamps to dates.',
  '- Add units and cap decimals to 2 d.p.',
  'Numeric conventions:',
  '- Epochs are milliseconds; holding time = (sellTime - buyTime) / 60000 minutes (2 d.p.).',
  '- from.amount and to.amount are in token units (e.g. SOL), not lamports unless explicitly labeled.',
  '- priceUsd / price_usd is unit price in USD.',
  '- Leave price.sol blank if not provided.',
  '- Notional values: volume.usd and volume.sol; always label units.',
  '- Only show realized PnL if derivable from merged.',
  '- Cross-check large totals against volume.sol.',
  'Equity / Session Context (if merged.chart exists):',
  '- Use merged.walletStats: timeframeStart/End (dates), startPnlPct, endPnlPct, trend.',
  '- Note max run-up and max drawdown with units.',
  '- Include up to two regime events.',
  '- Maximum of three clear, labeled bullets.',
  'End every Markdown report with operator_summary.',
  'Do NOT show operator_summary content in Markdown.',
  'Emit operator_summary only as JSON under the required property.',
  'operator_summary must include: streak (hot/cold/mixed/unknown), window, recent_win_rate (0–1 or null), realized_avg_gain_pct (number or null), biggest win and loss (mint, symbol, pct), and a concise persona headline (max one emoji).',
  'Strictly follow numeric, labeling, grouping, and data-source rules.'
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'string' },
    markdown: { type: 'string' },
    operator_summary: {
      type: 'object',
      properties: {
        streak: { type: 'string', enum: ['hot', 'cold', 'mixed', 'unknown'] },
        window: { type: 'string' },
        recent_win_rate: { type: ['number', 'null'] },
        realized_avg_gain_pct: { type: ['number', 'null'] },
        biggest_win: {
          type: 'object',
          properties: {
            mint: { type: 'string' },
            symbol: { type: 'string' },
            gain_pct: { type: ['number', 'null'] }
          },
          required: ['mint', 'symbol', 'gain_pct'],
          additionalProperties: false
        },
        biggest_loss: {
          type: 'object',
          properties: {
            mint: { type: 'string' },
            symbol: { type: 'string' },
            loss_pct: { type: ['number', 'null'] }
          },
          required: ['mint', 'symbol', 'loss_pct'],
          additionalProperties: false
        },
        notes: { type: 'string' }
      },
      required: ['streak', 'window', 'recent_win_rate', 'realized_avg_gain_pct', 'biggest_win', 'biggest_loss', 'notes'],
      additionalProperties: false
    }
  },
  required: ['version', 'markdown', 'operator_summary'],
  additionalProperties: false
};

/**
 * Create a wallet analysis runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeWallet: (args: { merged: Object, model?: string, purpose?: string }) => Promise<{ version: string, markdown: string, operator_summary?: Object }> }}
 */
function createWalletAnalysis(client) {
  const { callResponses, parseResponsesJSON, log } = client || defaultClient;

  /**
   * Run the wallet analysis Responses job and normalize the envelope.
   * @param {{ merged: Object, model?: string, purpose?: string }} params
   * @returns {Promise<{ version: string, markdown: string, operator_summary?: Object }>}
   */
  async function analyzeWallet({ merged, model, purpose }) {
    if (!merged) {
      throw new Error('[walletAnalysis] missing merged payload');
    }

    const res = await callResponses({
      system: SYSTEM,
      model,
      // temperature: 0.5,
      top_p: 0.9,
      // seed: 77,
      // Provide a minimal JSON schema envelope expected by callResponses (schema mode)
      name: 'dossier_freeform_v1',
      schema: RESPONSE_SCHEMA,
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

  return { analyzeWallet };
}

// Default instance using the shared client for convenience / backward compatibility.
const { analyzeWallet } = createWalletAnalysis(defaultClient);

module.exports = {
  createWalletAnalysis,
  analyzeWallet
};