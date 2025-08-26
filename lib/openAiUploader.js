// lib/openAiUploader.js — stub implementation
// Replace with real OpenAI API integration.

async function sendBatch(rows) {
  console.log(`[openAiUploader] sending batch of ${rows.length} rows to OpenAI…`);

  // TODO: integrate with OpenAI API here.
  // For now, just simulate a response.
  return rows.map(r => ({
    wallet: r.wallet,
    mint: r.mint,
    decision: 'proceed',
    reasons: ['stub response from openAiUploader'],
  }));
}

module.exports = { sendBatch };
