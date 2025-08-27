// lib/openAiUploader.js — uploader with optional real OpenAI integration
// If lib/openaiClient.js exports `analyzeBatch`, we'll use it; otherwise we fall back to a stub.

const DEFAULT_BATCH_SIZE = Number(process.env.OPENAI_BATCH_SIZE || 200);

let analyzeBatch = null;
try {
  // eslint-disable-next-line global-require
  const client = require('./openAiClient');
  if (client && typeof client.analyzeBatch === 'function') {
    analyzeBatch = client.analyzeBatch;
  }
} catch (_) {
  // keep analyzeBatch as null → stub path
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toPayloadRow(r) {
  // r may be an enriched row from enrichTrades with shape { base, snapshot, features, ... }
  const base = r.base || r;
  return {
    traderName: base.traderName || null,
    wallet: base.wallet || null,
    mint: r.mint || base.mint || null,
    ts: r.ts || base.ts || null,
    side: base.side || null,
    sizeSol: base.sizeSol || base.size || null,
    // keep features compact; avoid dumping huge snapshots
    features: r.features || null,
  };
}

async function sendBatch(rows, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const payload = rows.map(toPayloadRow);
  console.log(`[openAiUploader] preparing ${payload.length} rows (batchSize=${batchSize})`);

  // If no real client, return stub responses that preserve traderName & wallet
  if (!analyzeBatch) {
    console.log('[openAiUploader] OpenAI client not found; returning stub responses');
    return payload.map(p => ({
      traderName: p.traderName,
      wallet: p.wallet,
      mint: p.mint,
      decision: 'proceed',
      reasons: ['stub response from openAiUploader'],
    }));
  }

  const batches = chunk(payload, batchSize);
  const results = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    console.log(`[openAiUploader] sending batch ${i + 1}/${batches.length} (size=${batch.length}) to OpenAI…`);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await analyzeBatch(batch);
      if (Array.isArray(res)) {
        results.push(...res);
      } else {
        results.push(res);
      }
      console.log(`[openAiUploader] ✅ batch ${i + 1} ok (${results.length} total rows processed)`);
    } catch (err) {
      console.error('[openAiUploader] ❌ batch failed; falling back to stub for this batch:', err?.message || err);
      // Fallback: emit stub decisions for the failed batch so pipeline keeps flowing
      results.push(
        ...batch.map(p => ({
          traderName: p.traderName,
          wallet: p.wallet,
          mint: p.mint,
          decision: 'proceed',
          reasons: ['stub fallback due to OpenAI error'],
        }))
      );
    }
  }

  return results;
}

module.exports = { sendBatch };
