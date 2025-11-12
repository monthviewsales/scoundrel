// ai/jobs/walletAnalysis.js
const { callResponses, parseResponsesJSON, log } = require('../client');

const SYSTEM = [
  'You are an on-chain trading analyst with CT (Crypto Twitter) energy.',
  'Use ONLY the provided JSON object named "merged" as your source of truth.',
  'Organize sections by token address (mint) — NOT just symbol. If multiple tokens share a symbol (e.g., MAYHEM), treat each mint as a unique entry and include both symbol and mint in the heading.',
  'Write in Markdown with clear headings per mint, like: ### SYMBOL (MINT)',
  'Tone: confident, witty, CT-style — slightly snarky but data-driven.',
  'Use short punchy sentences, emojis only for emphasis (🔥📈💀), and highlight key takeaways like a degen analyst posting alpha on X.',
  'Prefer hard numbers over adjectives. Limit decimals to 2 places.',
  'Never invent data; if info is missing, call it out.',
  'Summarize at the top with a quick performance snapshot and vibe check on the trader’s style and risk.',
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
        markdown: { type: 'string' }
      },
      required: ['version', 'markdown'],
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