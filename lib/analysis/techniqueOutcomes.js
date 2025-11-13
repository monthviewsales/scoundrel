/**
 * Shared technique & outcomes analysis utilities (CommonJS)
 * Single source of truth for:
 *  - basic stats helpers
 *  - FIFO realized outcomes per mint
 *  - entry style detection from buy spacing
 *  - technique features (last N mints)
 *  - aggregate outcomes (winRate, exit pctiles, hold mins, spike days)
 */

// ---------- Stats helpers ----------
function mean(a){ if(!a||!a.length) return null; return a.reduce((x,y)=>x+y,0)/a.length; }
function median(a){ if(!a||!a.length) return null; const s=[...a].sort((x,y)=>x-y); const i=Math.floor(s.length/2); return s.length%2?s[i]:(s[i-1]+s[i])/2; }
function percentile(a,p){ if(!a||!a.length) return null; const s=[...a].sort((x,y)=>x-y); const idx=Math.min(s.length-1, Math.max(0, Math.round((p/100)*(s.length-1)))); return s[idx]; }
function stddev(a){ if(!a||!a.length) return null; const m=mean(a); const v=mean(a.map(x=>Math.pow(x-m,2))); return v==null?null:Math.sqrt(v); }
function timeDiffs(ts){ const out=[]; for(let i=1;i<ts.length;i++){ out.push((ts[i]-ts[i-1])/60000); } return out; }
const last = a => (a && a.length ? a[a.length-1] : null);
const first = a => (a && a.length ? a[0] : null);

// ---------- FIFO realized stats per mint ----------
/**
 * Compute realized outcomes using FIFO pairing.
 * @param {Array<{amount:number, priceUsd:number, time:number}>} buys
 * @param {Array<{amount:number, priceUsd:number, time:number}>} sells
 * @returns {{ nClosed:number, medianGainPct:number|null, p75GainPct:number|null, medianHoldMins:number|null, perLeg?:number[] }}
 */
function computeRealizedStats(buys, sells){
  const buyQueue = [];
  const gains = [];
  const holds = [];
  let firstBuyTs = null;

  for (const b of (buys||[])){
    buyQueue.push({ qty: Number(b.amount)||0, priceUsd: Number(b.priceUsd)||0, time: Number(b.time)||0 });
    if (firstBuyTs == null) firstBuyTs = Number(b.time)||0;
  }

  for (const s of (sells||[])){
    let sellQty = Number(s.amount)||0;
    let realizedUsd = 0;
    let spentUsd = 0;

    while (sellQty > 0 && buyQueue.length){
      const lot = buyQueue[0];
      const take = Math.min(lot.qty, sellQty);
      realizedUsd += take * (Number(s.priceUsd)||0);
      spentUsd   += take * (Number(lot.priceUsd)||0);
      lot.qty    -= take;
      sellQty    -= take;
      if (lot.qty <= 0) buyQueue.shift();
    }

    if (spentUsd > 0){
      const pct = (realizedUsd - spentUsd) / spentUsd * 100;
      gains.push(pct);
    }

    if (!buyQueue.length && firstBuyTs != null){
      const hold = ((Number(s.time)||0) - firstBuyTs) / 60000;
      if (isFinite(hold)) holds.push(hold);
      firstBuyTs = null;
    }
  }

  return {
    nClosed: gains.length,
    medianGainPct: median(gains),
    p75GainPct: percentile(gains,75),
    medianHoldMins: median(holds),
    perLeg: gains,
  };
}

// ---------- Entry style detection ----------
/**
 * Detect entry style from buy spacing.
 * @param {Array<{time:number}>} buys
 * @returns {{ signal:'single'|'scale_in'|'twap'|'dca', confidence:number }}
 */
function detectEntryStyle(buys){
  if (!buys || buys.length <= 1) return { signal: 'single', confidence: 0.9 };
  const times = buys.map(b => Number(b.time)||0).sort((a,b)=>a-b);
  const diffs = timeDiffs(times);
  const avg = mean(diffs) || 0; const sd = stddev(diffs) || 0;
  const clustered = diffs.some(d => d <= 15); // within 15 minutes considered clustered
  if (buys.length >= 3 && avg>0 && sd!=null && sd/avg <= 0.10) return { signal: 'twap', confidence: 0.75 };
  if (clustered) return { signal: 'scale_in', confidence: 0.70 };
  return { signal: 'dca', confidence: 0.50 };
}

// ---------- Technique features from per-mint map ----------
/**
 * Build technique features from a map: { [mint]: trade[] }
 * @param {Record<string,Array<Object>>} mintMap
 * @param {number} featureMintCount
 */
function buildTechniqueFeaturesFromMintMap(mintMap, featureMintCount){
  const rows = [];
  for (const [mint, list] of Object.entries(mintMap||{})){
    const buys  = (list||[]).filter(t=>t.type==='buy').sort((a,b)=>a.time-b.time);
    const sells = (list||[]).filter(t=>t.type==='sell').sort((a,b)=>a.time-b.time);
    if (!buys.length && !sells.length) continue;
    const lastTs = Math.max(...(list||[]).map(t=>Number(t.time)||0));
    const spacing = timeDiffs(buys.map(b=>Number(b.time)||0));
    const style = detectEntryStyle(buys);
    const realized = computeRealizedStats(buys, sells);

    const venueCounts = buys.reduce((acc,t)=>{ const k=t.program||'unknown'; acc[k]=(acc[k]||0)+1; return acc; },{});
    const total = Object.values(venueCounts).reduce((a,b)=>a+b,0) || 1;
    const venueMix = Object.fromEntries(Object.entries(venueCounts).map(([k,v])=>[k, v/total]));

    rows.push({
      mint,
      symbol: buys[0]?.meta?.to?.symbol || sells[0]?.meta?.to?.symbol || null,
      startTs: first(buys)?.time ?? first(list)?.time ?? null,
      endTs:   last(sells)?.time  ?? lastTs,
      nBuys: buys.length,
      nSells: sells.length,
      entrySpacingMinsAvg: mean(spacing),
      entrySpacingMinsStd: stddev(spacing),
      entryStyleSignal: style.signal,
      entryStyleConfidence: style.confidence,
      realized,
      venueMix,
      marketCapEntryUsdMedian: null,
    });
  }

  const picked = rows.sort((a,b)=>(b.endTs||0)-(a.endTs||0)).slice(0, Math.max(0, Number(featureMintCount)||0));
  const realizedRows = picked.map(r=>r.realized).filter(Boolean);

  // NOTE: Portfolio-level stats should reflect all closed legs, not medians-per-coin,
  // to prevent under/over-weighting coins with many/few closes.
  // Aggregate per-leg realized outcomes across picked mints (avoid averaging coin medians)
  const allLegs = realizedRows.flatMap(r => Array.isArray(r.perLeg) ? r.perLeg : []).filter(v => typeof v === 'number' && isFinite(v));
  const legsWinRate = allLegs.length ? (allLegs.filter(x => x > 0).length / allLegs.length) : null;
  const legsAvgGain = allLegs.length ? mean(allLegs) : null;

  const overall = {
    nCoins: picked.length,
    meanBuysPerCoin: mean(picked.map(r=>r.nBuys)) || 0,
    medianHoldMins: median(realizedRows.map(r=>r.medianHoldMins).filter(v=>v!=null)),
    winRate: legsWinRate,
    avgRealizedGainPct: legsAvgGain,
    venueShare: (()=>{ const acc={}; for(const m of picked){ for(const [k,v] of Object.entries(m.venueMix)) acc[k]=(acc[k]||0)+v; } const tot=Object.values(acc).reduce((a,b)=>a+b,0)||1; for(const k in acc) acc[k]=acc[k]/tot; return acc; })(),
    marketCapEntryUsdMedian: null,
  };

  return { coins: picked, overall };
}

// ---------- Outcomes from per-mint map ----------
/**
 * Compute overall outcomes JSON from per-mint trades and optional chart.
 * Adds additional distribution and round-trip metrics to help Pass B reason about variance and loss discipline.
 * @param {Record<string,Array<Object>>} mintMap
 * @param {Array<Object>|null} chart
 * @returns {{
 *   winRate:number|null,
 *   medianExitPct:number|null,
 *   p75ExitPct:number|null,
 *   p25ExitPct:number|null,
 *   p95ExitPct:number|null,
 *   iqrExitPct:number|null,
 *   maxWinPct:number|null,
 *   maxLossPct:number|null,
 *   pctTradesLtMinus10:number|null,
 *   medianHoldMins:number|null,
 *   medianRoundTripPct:number|null,
 *   medianRoundTripHoldMins:number|null,
 *   spikeDays:Array<{date:string|null,pnlPct:number}>
 * }}
 */
function computeOutcomesFromMintMap(mintMap, chart){
  const perMint = [];
  const roundTrips = [];
  for (const [mint, list] of Object.entries(mintMap||{})){
    const buys  = (list||[]).filter(t=>t.type==='buy').sort((a,b)=>a.time-b.time);
    const sells = (list||[]).filter(t=>t.type==='sell').sort((a,b)=>a.time-b.time);
    if (!buys.length && !sells.length) continue;
    const r = computeRealizedStats(buys, sells);
    perMint.push({ mint, r });

    // Simple round-trip view (only when effectively flat: ≤2% residual size)
    const sumBuyQty  = buys.reduce((a,t)=>a + (Number(t.amount)||0), 0);
    const sumSellQty = sells.reduce((a,t)=>a + (Number(t.amount)||0), 0);
    const sumBuyUsd  = buys.reduce((a,t)=>a + ((Number(t.amount)||0) * (Number(t.priceUsd)||0)), 0);
    const sumSellUsd = sells.reduce((a,t)=>a + ((Number(t.amount)||0) * (Number(t.priceUsd)||0)), 0);
    if (sumBuyQty > 0) {
      const residual = Math.abs(sumBuyQty - sumSellQty) / sumBuyQty;
      if (residual <= 0.02 && sumBuyUsd > 0) {
        const rtPct = (sumSellUsd - sumBuyUsd) / sumBuyUsd * 100;
        const rtHold = ( (last(sells)?.time ?? last(list)?.time ?? 0) - (first(buys)?.time ?? first(list)?.time ?? 0) ) / 60000;
        if (isFinite(rtPct) && isFinite(rtHold)) {
          roundTrips.push({ rtPct, rtHold });
        }
      }
    }
  }

  const medGains = perMint.map(x => x.r.medianGainPct).filter(v => v != null);
  const holdMeds = perMint.map(x => x.r.medianHoldMins).filter(v => v != null);

  const winRate = medGains.length ? (medGains.filter(x=>x>0).length / medGains.length) : null;
  const medianExitPct = median(medGains);
  const p75ExitPct = percentile(medGains, 75);
  const p25ExitPct = percentile(medGains, 25);
  const p95ExitPct = percentile(medGains, 95);
  const iqrExitPct = (p75ExitPct!=null && p25ExitPct!=null) ? (p75ExitPct - p25ExitPct) : null;
  const maxWinPct = medGains.length ? Math.max(...medGains) : null;
  const maxLossPct = medGains.length ? Math.min(...medGains) : null;
  const pctTradesLtMinus10 = medGains.length ? (medGains.filter(x => x < -10).length / medGains.length) : null;
  const medianHoldMins = median(holdMeds);
  const medianRoundTripPct = roundTrips.length ? median(roundTrips.map(x=>x.rtPct).filter(v=>v!=null)) : null;
  const medianRoundTripHoldMins = roundTrips.length ? median(roundTrips.map(x=>x.rtHold).filter(v=>v!=null)) : null;

  const spikeDays = [];
  if (Array.isArray(chart)){
    for (const d of chart){
      const pct = (d && (d.pnlPercentage ?? d.pnl_pct));
      if (typeof pct === 'number' && Math.abs(pct) >= 200){
        spikeDays.push({ date: d.date || d.timestamp || d.ts || null, pnlPct: pct });
      }
    }
  }

  return {
    winRate,
    medianExitPct,
    p75ExitPct,
    p25ExitPct,
    p95ExitPct,
    iqrExitPct,
    maxWinPct,
    maxLossPct,
    pctTradesLtMinus10,
    medianHoldMins,
    medianRoundTripPct,
    medianRoundTripHoldMins,
    spikeDays
  };
}

module.exports = {
  // helpers
  mean, median, percentile, stddev, timeDiffs,
  // primitives
  computeRealizedStats,
  detectEntryStyle,
  // feature builders
  buildTechniqueFeaturesFromMintMap,
  computeOutcomesFromMintMap,
};