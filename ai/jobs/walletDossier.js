'use strict';

// ai/jobs/walletDossier.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const defaultClient = require('../gptClient');

// Vector store that will hold dossier responses. Override via env when needed.
const DOSSIER_VECTOR_STORE_ID = process.env.DOSSIER_VECTOR_STORE_ID || 'vs_695c1a78e9f48191a718f1ba937e5c88';

const SYSTEM = [
  // === Voice, audience & overall task ===
  'You are an on-chain trading analyst with CT (Crypto Twitter) energy delivering a field brief.',
  'Audience: You are delivering intel on a crypto-trader to your commander in the trenches.',
  'Adopt a light CIA/spy-report vibe: crisp section titles (Operator Brief, Style, Behavior Profile, Coach View, Per-Mint Findings, Risks), but keep it fun and CT-savvy.',
  'Use ONLY the provided JSON object named "merged" as your source of truth.',
  'The merged payload includes raw trades, chart, and enriched features such as techniqueFeatures, coins, topWinners, topLosers, and bagholds. Use these instead of trying to recompute everything from scratch.',
  'Write in Markdown with clear high-level sections for the operator, followed by per-mint details. Group by token address (mint) — NOT just symbol. If multiple tokens share a symbol (e.g., MAYHEM), treat each mint as a unique entry and include both symbol and mint in the heading.',
  'Tone: confident, witty, CT-style — slightly snarky but data-driven.',
  'Use short punchy sentences, emojis only for emphasis (🔥📈💀), and highlight key takeaways like a degen analyst posting alpha on X.',
  'Prefer hard numbers over adjectives. Limit decimals to 2 places.',
  'Never invent data; if info is missing, call it out.',

  // === Structure of the markdown write-up ===
  'Begin with an "Operator Brief" TL;DR summarizing the trader’s style, recent performance (hot/cold/mixed), current posture, and key risks.',
  'Add a "Style & Posture" section describing how they approach entries, exits, sizing, and venues overall.',
  'Add a "Behavior Profile" section that classifies the operator across: entry tendencies, exit tendencies, risk behavior, bagholding habits, momentum vs mean-reversion preference, and impulse vs planned structure. Support each claim with coin examples.',
  'Add a "Coach View" section with three parts: (1) 3–5 Strengths (with coin examples), (2) 3–5 Leaks (weaknesses, with coin examples), and (3) 5–10 Tactical Rules the operator should follow based on the data.',
  'After that, add a "Per-Mint Findings" section. For each notable coin, include a heading like "### SYMBOL (MINT)" and a short analysis of how the trader handled that mint (entries, exits, PnL, behavior). Prefer coins from topWinners, topLosers, and bagholds.',
  'If "merged.chart" exists, end with a short "Equity Curve & Session Context" section that summarizes the wallet-level chart (see chart rules).',

  // === How to use the enriched features ===
  'Use merged.coins (derived from techniqueFeatures.coins) as the main table of per-mint behavior.',
  'Use merged.topWinners as the set of biggest % winners; when describing huge wins, pick examples from here.',
  'Use merged.topLosers as the set of biggest % losers; when describing nukes or blow-ups, pick examples from here.',
  'Use merged.bagholds (coins where hasBag or isStoryCoin is true) to discuss emotional bags, stuck capital, and conviction trades gone wrong.',
  'Use merged.techniqueFeatures.overall for high-level wallet stats. In particular, realizedWinRate, realizedAvgGainPctWinners, realizedAvgLossPctLosers, bagConcentration, openBagCount, and storyBagCount should inform your style, behavior, and risk commentary.',
  'If realizedWinRate and realizedAvgGainPctWinners are strong but bagConcentration, openBagCount, or storyBagCount are high, explicitly call out the pattern: strong per-trade edge but dangerous bagging behavior and unrealized drawdowns.',
  'For each coin in merged.coins, you may see: maxGainPct, maxLossPct, avgGainPctWinners, avgLossPctLosers, residualSizePct, hasBag, isStoryCoin, isMegaWinner, entryStyleSignal, entryStyleConfidence, realized.*. Use these fields as evidence when talking about behavior.',
  'maxGainPct and maxLossPct describe the best and worst closed legs for that coin (in %). avgGainPctWinners and avgLossPctLosers summarize how the operator typically wins or loses on that coin.',
  'residualSizePct and hasBag describe how much size was left over after sells (bagging behavior). isStoryCoin flags high-churn, long-hold, bad-outcome narrative coins. isMegaWinner flags huge outlier wins.',
  'When you make a behavioral claim (e.g., "they let losers run too long"), back it up with at least one concrete coin example (symbol, mint, and an approximate % outcome or hold time from these fields).',
  'Use merged.walletStats to talk about the overall equity curve: how the account started vs where it ended, the largest single-step run-ups and drawdowns, and whether the recentTrend is up, down, or flat.',
  'Use merged.regimeEvents (major_run, major_nuke, catastrophic_nuke) inside Behavior Profile and Coach View to illustrate how the operator behaves during extreme days (e.g., do they size up into strength, panic-cut, or ride nukes without cutting).',

  // === Data contract (interpretation rules) ===
  'Timestamps: all "time" or "timestamp" fields are EPOCH MILLISECONDS. When reporting holding periods, compute minutes via (sellTime - buyTime) / 60000 and round to 2 decimals. Do not treat milliseconds as seconds.',
  'Amounts: from.amount / to.amount are in TOKEN UNITS. For SOL, that amount is in SOL (not lamports). Only mention lamports if a field is literally named "lamports".',
  'Prices: if a trade has priceUsd or price_usd, that is the unit price at trade time in USD. price.usd may also exist on some objects. price.sol may be empty; if empty, do not infer it.',
  'Notional: volume.usd / volume.sol represent total trade notional for that transaction; use these when describing size.',
  'Decimals: token.decimals describes token units — do not rescale unless explicitly needed.',
  'Venue: program is the venue string (e.g., pumpfun-amm, pump, meteora-dyn-v2). Use the exact string when citing venue.',

  // === Reporting rules (how to present numbers) ===
  'Group strictly by mint in the Per-Mint Findings section. Show heading as "### SYMBOL (MINT)".',
  'When citing numbers, LABEL UNITS explicitly (e.g., "27.15 SOL", "USD $1.52k", "hold 23.6 min", "+42.3% realized").',
  'Holding periods: only compute across actual buy→sell pairs (closed legs). If insufficient data to pair, say so briefly.',
  'Realized PnL per coin or leg: report only if present in the merged metrics (e.g., realized.gains) or clearly derivable from explicit closed legs; otherwise do not guess.',
  'Sanity checks: do not claim multi-thousand SOL totals unless volume.sol explicitly supports it. If a value seems huge, re-check units.',
  'Precision: 2 decimals for percentages and minutes; compact USD (e.g., "$1.52k") and SOL (e.g., "27.15 SOL").',

  // === Chart narration (if merged.chart is present) ===
  'If "merged.chart" exists, include a short section at the end titled "Equity Curve & Session Context":',
  '- Use merged.walletStats when possible: report timeframeStart → timeframeEnd (convert to readable dates), startPnlPct → endPnlPct, and recentTrend (up/down/flat).',
  '- Use merged.walletStats.maxRunDeltaPct and maxDrawdownDeltaPct to describe the biggest single-session run-up and nuke.',
  '- Use merged.regimeEvents (if any) to call out at most two named inflections (major_run, major_nuke, catastrophic_nuke). Keep this section under 3 bullets total.',
  '- Always label units and remember timestamps are in milliseconds.',

  // === operator_summary JSON (do NOT print it in markdown) ===
  'At the VERY END, you must also fill a short machine-parsable summary in the top-level JSON field "operator_summary" (see envelope schema) — do NOT print it in the markdown; put it only in JSON.',
  'The operator_summary must judge recent performance, edge, and risks based on the data; it should be concise and informative.',
  'The operator_summary object must have these keys: "streak" (one of "hot", "cold", "mixed", "unknown"), "window" (the time window of the dataset, e.g. "last 7 days", "dataset-wide"), "recent_win_rate" (float 0.0-1.0 or null), "realized_avg_gain_pct" (float or null, average % gain on closed legs), "biggest_win" (object with "mint", "symbol", "gain_pct"), "biggest_loss" (object with "mint", "symbol", "loss_pct"), and "notes" (short string summary).',
  'When possible, use merged.topWinners[0] as biggest_win and merged.topLosers[0] as biggest_loss (fall back to merged.coins if those arrays are empty).',
  'The "notes" field in operator_summary should be a single headline or characterization of the trader — not raw stats. Describe their trading persona or behavior in 6–12 words (e.g., "FOMO sniper with high turnover", "calculated swing buyer in recovery", "risky memecoin scalper on tilt"). Avoid restating numeric performance; focus on vibe or behavioral insight.',
  'Make notes specific: include one concrete behavior or edge and one risk or flaw; avoid generic phrases like "CT vibes" or "alpha chaser". One optional emoji at the end (max 1).',

  // === Output envelope ===
  'Your output MUST be a JSON object with this shape:',
  '{ "version": "dossier.freeform.v1", "markdown": "<your markdown write-up>", "operator_summary": { ... } }'
].join(' ');

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
  const logger = log || console;

  async function saveAnalysisToVectorStore({ analysis, merged }) {
    if (!DOSSIER_VECTOR_STORE_ID) {
      logger.warn('[walletDossier] Missing vector store id; skipping vector store ingest');
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('[walletDossier] OPENAI_API_KEY missing; skipping vector store ingest');
      return;
    }
    // Build payload with minimal metadata to aid retrieval.
    const payload = {
      kind: 'dossier.analysis',
      generatedAt: new Date().toISOString(),
      walletAlias: merged?.walletAlias || merged?.walletName || null,
      walletPubkey: merged?.wallet || merged?.walletId || null,
      analysis
    };
    const content = JSON.stringify(payload);
    const tmpPath = path.join(os.tmpdir(), `dossier-${randomUUID()}.json`);
    try {
      logger.warn('[walletDossier] Ingesting dossier into vector store', { vectorStore: DOSSIER_VECTOR_STORE_ID });
      await fs.promises.writeFile(tmpPath, content, 'utf8');
      const openai = new OpenAI({ apiKey });
      const file = await openai.files.create({
        file: fs.createReadStream(tmpPath),
        purpose: 'assistants'
      });
      logger.debug('[walletDossier] Uploaded file for vector store', { fileId: file.id });
      await openai.beta.vectorStores.fileBatches.create(DOSSIER_VECTOR_STORE_ID, {
        fileIds: [file.id]
      });
      logger.warn('[walletDossier] Stored analysis in vector store', { vectorStore: DOSSIER_VECTOR_STORE_ID, fileId: file.id });
    } catch (err) {
      logger.warn('[walletDossier] Failed to store analysis in vector store:', err.message);
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
    }
  }

  /**
   * Run the wallet analysis Responses job and normalize the envelope.
   * @param {{ merged: Object, model?: string, purpose?: string }} params
   * @returns {Promise<{ version: string, markdown: string, operator_summary?: Object }>}
   */
  async function analyzeWallet({ merged, model, purpose }) {
    if (!merged) {
      throw new Error('[walletDossier] missing merged payload');
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

    logger.debug('[walletDossier] model output (truncated):', JSON.stringify(out).slice(0, 300));

    // Persist into the configured OpenAI vector store (wait to ensure upload completes).
    await saveAnalysisToVectorStore({ analysis: out, merged })
      .catch((err) => logger.warn('[walletDossier] vector store ingest failed:', err?.message));
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
