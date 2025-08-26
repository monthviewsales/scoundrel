

// lib/enrichTrades.js
// Asynchronously enrich parsed trades with token snapshots (t0) and features.
// Expects input trades shaped by parseTrades.js: { ts, mint, side, sizeSol, priceUsd, program }

const { SolanaTrackerClient } = require('./solanaTrackerClient');
const Features = require('./featureExtract');

/**
 * Simple concurrency controller without external deps.
 * @param {Array} items
 * @param {number} limit
 * @param {(item: any, idx: number) => Promise<any>} worker
 */
async function pMapLimit(items, limit, worker) {
  const ret = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (true) {
      const i = nextIndex;
      if (i >= items.length) return;
      nextIndex += 1;
      try {
        ret[i] = await worker(items[i], i);
      } catch (err) {
        ret[i] = { __error: err };
      }
    }
  }

  const runners = Array.from({ length: Math.max(1, limit) }, runOne);
  await Promise.all(runners.map(fn => fn()));
  return ret;
}

/**
 * Enrich trades with token snapshots at trade time (t0) and engineered features.
 * @param {Object} params
 * @param {Array} params.trades - parsed trades [{ ts, mint, side, sizeSol, ... }]
 * @param {SolanaTrackerClient} [params.client] - optional pre-initialized client
 * @param {number} [params.concurrency=6] - max concurrent API calls
 * @param {boolean} [params.includeOutcomes=false] - placeholder for future PnL labeling
 */
async function enrichTrades({ trades = [], client, concurrency = 6, includeOutcomes = false } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { enriched: [], count: 0, errors: 0 };
  }

  const st = client || new SolanaTrackerClient();
  console.log(`[enrichTrades] start: ${trades.length} trades, concurrency=${concurrency}, includeOutcomes=${includeOutcomes}`);

  const results = await pMapLimit(trades, concurrency, async (t) => {
    if (!t?.mint || !t?.ts) {
      return { __error: new Error('trade missing mint or ts'), trade: t };
    }

    try {
      // Fetch t0 snapshot (at or just before trade timestamp)
      const snapshot = await st.getTokenSnapshotAt({ mint: t.mint, ts: t.ts });
      if (!snapshot) {
        return { __error: new Error('no snapshot'), trade: t };
      }

      // TODO: when ready, compute horizon outcomes (5m/15m/1h/24h) here
      const labels = includeOutcomes ? null : null;

      const features = Features.make({
        side: t.side,
        size: t.sizeSol,
        priceUsd: t.priceUsd,
      }, snapshot);

      const net = Features.normalizeFeesAndPnL({ trade: { priorityFee: 0, platformFeeUI: 0, lpFeeUI: 0 }, labels });

      return {
        mint: t.mint,
        ts: t.ts,
        base: t,
        snapshot,
        features,
        net,
      };
    } catch (err) {
      return { __error: err, trade: t };
    }
  });

  const enriched = results.filter(r => !r?.__error);
  const errors = results.length - enriched.length;

  console.log(`[enrichTrades] done: enriched=${enriched.length}, errors=${errors}`);
  return { enriched, count: enriched.length, errors };
}

module.exports = { enrichTrades };