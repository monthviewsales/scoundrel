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
      nextIndex += 1;
      if (i >= items.length) return;
      try {
        ret[i] = await worker(items[i], i);
      } catch (err) {
        ret[i] = { __error: err, trade: items[i] };
      }
    }
  }

  const runners = [];
  const n = Math.max(1, Number(limit) || 1);
  for (let i = 0; i < n; i += 1) {
    runners.push(runOne());
  }
  await Promise.all(runners);
  return ret;
}

function isFeeLike(prev, cur) {
  if (!prev || !cur) return false;
  if (!prev.mint || !cur.mint || prev.mint !== cur.mint) return false;
  if (!prev.side || !cur.side || prev.side === cur.side) return false; // must be opposite directions
  const dt = Math.abs((cur.ts || 0) - (prev.ts || 0));
  if (!(dt <= 10)) return false; // within 10 seconds
  const prevSize = Number(prev.sizeSol || 0);
  const curSize = Number(cur.sizeSol || 0);
  if (!(prevSize > 0 && curSize > 0)) return false;
  // micro leg if current is <= 25% of previous
  return curSize <= (0.25 * prevSize);
}
// NOTE: Same-side small follow-ups (e.g., multiple quick BUYS) are treated as legitimate scaling and are NOT fee-like by design.

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

  // Build per-mint sorted order so we can detect fee-like micro legs using prior leg context
  const byMint = new Map();
  trades.forEach((t, i) => {
    if (!t?.mint) return;
    if (!byMint.has(t.mint)) byMint.set(t.mint, []);
    byMint.get(t.mint).push({ i, t });
  });
  // sort each mint’s legs by ts asc and remember the previous index for each row
  const prevIndexMap = new Map(); // key: global index i, val: previous global index or null
  for (const [mint, arr] of byMint.entries()) {
    arr.sort((a, b) => (a.t.ts || 0) - (b.t.ts || 0));
    for (let k = 0; k < arr.length; k += 1) {
      const cur = arr[k];
      const prev = k > 0 ? arr[k - 1] : null;
      prevIndexMap.set(cur.i, prev ? prev.i : null);
    }
  }

  // action_kind semantics:
  //  - init_buy: exposure was ~0 then a BUY
  //  - scale_in: BUY following a BUY with non-zero exposure
  //  - re_entry: BUY following a SELL while exposure still > EPS
  //  - partial_sell: SELL that does not flatten exposure
  //  - final_exit: SELL that brings exposure within EPS of zero and increments round_trip_id

  // --- Pre-pass: compute running SOL exposure per mint and classify action kinds ---
  const exposureBefore = new Map(); // key: global index -> exposure (SOL) before this leg
  const exposureAfter  = new Map(); // key: global index -> exposure (SOL) after this leg
  const actionKind     = new Map(); // key: global index -> 'init_buy'|'scale_in'|'partial_sell'|'re_entry'|'final_exit'
  const roundTripId    = new Map(); // key: global index -> integer round-trip id per mint

  const EPS = Number(process.env.EXPOSURE_EPS || 0.02); // SOL tolerance to consider flat
  for (const [mint, arr] of byMint.entries()) {
    // arr is already sorted by ts asc from the prevIndexMap build
    let expo = 0; // running exposure in SOL (buys increase, sells decrease)
    let rt = 0;   // round-trip counter per mint
    let lastSide = null;

    for (let k = 0; k < arr.length; k += 1) {
      const { i: idx, t } = arr[k];
      const size = Number(t.sizeSol || 0);
      const side = t.side;

      // before
      exposureBefore.set(idx, expo);

      // apply
      if (side === 'buy') expo += size; else if (side === 'sell') expo -= size;

      // after
      exposureAfter.set(idx, expo);

      // classify
      let kind = null;
      if (side === 'buy') {
        if (Math.abs(exposureBefore.get(idx)) <= EPS) kind = 'init_buy';
        else if (lastSide === 'buy') kind = 'scale_in';
        else kind = 're_entry';
      } else { // sell
        if (Math.abs(expo) <= EPS) kind = 'final_exit';
        else kind = 'partial_sell';
      }
      actionKind.set(idx, kind);

      // assign round-trip id (increments when we hit a final exit)
      roundTripId.set(idx, rt);
      if (kind === 'final_exit') rt += 1;

      lastSide = side;
    }
  }

  const results = await pMapLimit(trades, concurrency, async (t, globalIndex) => {
    if (!t?.mint || !t?.ts) {
      return { __error: new Error('trade missing mint or ts'), trade: t };
    }

    try {
      // Determine if this leg looks like a fee/micro leg using prior leg context for the same mint
      const prevIdx = prevIndexMap.get(globalIndex);
      const prevRow = (typeof prevIdx === 'number' && prevIdx >= 0) ? trades[prevIdx] : null;
      const isFeeCandidate = isFeeLike(prevRow, t);

      // Fetch t0 snapshot (at or just before trade timestamp)
      const snapshot = await st.getTokenSnapshotAt({ mint: t.mint, ts: t.ts });
      if (!snapshot) {
        return { __error: new Error('no snapshot'), trade: t };
      }

      // TODO: when ready, compute horizon outcomes (5m/15m/1h/24h) here
      const labels = includeOutcomes ? null : null;

      // --- Derive SOL/USD at trade time ---
      const pools = Array.isArray(snapshot?.pools) ? snapshot.pools : [];
      const SOL_MINT = process.env.SOL_MINT || 'So11111111111111111111111111111111111111111';

      // Try to find a pool with SOL explicitly on one side
      const poolQuoteSol = pools.find(p => (p?.quoteToken || '').includes(SOL_MINT));
      const poolBaseSol  = pools.find(p => (p?.baseToken  || '').includes(SOL_MINT));
      const p = poolQuoteSol || poolBaseSol || pools[0] || null;

      let solUsdAtTs = null;
      // Primary source: explicit price on snapshot if present
      if (typeof snapshot?.priceAt?.solUsd === 'number' && Number.isFinite(snapshot.priceAt.solUsd)) {
        solUsdAtTs = snapshot.priceAt.solUsd;
      }
      // Fallback: derive from pool liquidity; choose denominator based on which side is SOL
      if ((solUsdAtTs === null || Number.isNaN(solUsdAtTs)) && p?.liquidity && Number.isFinite(p.liquidity.usd)) {
        const denom = poolQuoteSol
          ? p.liquidity.quote
          : (poolBaseSol ? p.liquidity.base : p?.liquidity?.quote);
        if (Number.isFinite(denom) && denom > 0) {
          solUsdAtTs = p.liquidity.usd / denom;
        }
      }
      // Sanity band for SOL/USD; discard crazy values
      if (!(solUsdAtTs > 50 && solUsdAtTs < 1000)) {
        solUsdAtTs = null;
      }

      // Token unit price (tiny) if available on snapshot
      const tokenUnitPriceUsd = (typeof snapshot?.priceAt?.usd === 'number') ? snapshot.priceAt.usd : null;

      const sizeSol = Number(t.sizeSol || 0);
      let legValueUsd = (Number.isFinite(sizeSol) && Number.isFinite(solUsdAtTs))
        ? Number((sizeSol * solUsdAtTs).toFixed(2))
        : null;

      // If this looks like a fee-like opposite-side micro leg AND SOL/USD was not sane, drop the leg USD to avoid inflation
      if (isFeeCandidate && (solUsdAtTs == null)) {
        legValueUsd = null;
      }

      // Build richer features for downstream
      const features = {
        side: t.side,
        size: sizeSol,
        sol_usd_at_ts: Number.isFinite(solUsdAtTs) ? solUsdAtTs : null,
        token_unit_price_usd: tokenUnitPriceUsd,
        leg_value_usd: legValueUsd,
        liquidity_usd: (typeof p?.liquidity?.usd === 'number') ? p.liquidity.usd : null,
        pool_age_min: (p?.createdAt ? Math.max(0, Math.floor((t.ts - Math.floor(p.createdAt / 1000)) / 60)) : null),
        is_fee_candidate: isFeeCandidate,
        exposure_before_sol: Number.isFinite(exposureBefore.get(globalIndex)) ? Number(exposureBefore.get(globalIndex).toFixed(6)) : null,
        exposure_after_sol:  Number.isFinite(exposureAfter.get(globalIndex))  ? Number(exposureAfter.get(globalIndex).toFixed(6))  : null,
        action_kind: actionKind.get(globalIndex) || null,
        round_trip_id: roundTripId.get(globalIndex) ?? null,
      };

      // Keep compatibility: still call feature extractor if it relies on snapshot
      let fx = {};
      try {
        fx = Features.make({ side: t.side, size: t.sizeSol, priceUsd: t.priceUsd }, snapshot) || {};
      } catch (_) { /* best-effort */ }
      Object.assign(features, fx);

      const net = Features.normalizeFeesAndPnL({ trade: { priorityFee: 0, platformFeeUI: 0, lpFeeUI: 0 }, labels });

      return {
        mint: t.mint,
        ts: t.ts,
        base: {
          ...t,
          solUsdAtTs,
          legValueUsd,
          tokenUnitPriceUsd,
          isFeeCandidate,
          exposureBeforeSol: exposureBefore.get(globalIndex) ?? null,
          exposureAfterSol: exposureAfter.get(globalIndex) ?? null,
          actionKind: actionKind.get(globalIndex) || null,
          roundTripId: roundTripId.get(globalIndex) ?? null,
        },
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
