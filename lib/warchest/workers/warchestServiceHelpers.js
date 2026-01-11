'use strict';

const DEFAULT_ALERT_CAP = 8;

/**
 * Push a service alert into a bounded list.
 *
 * @param {Array} alerts
 * @param {string} level
 * @param {string} message
 * @param {object} [meta]
 * @returns {void}
 */
function pushServiceAlert(alerts, level, message, meta) {
  if (!Array.isArray(alerts)) return;
  alerts.unshift({
    ts: Date.now(),
    level: level || 'info',
    message: String(message || ''),
    meta: meta || null,
  });
  if (alerts.length > DEFAULT_ALERT_CAP) alerts.length = DEFAULT_ALERT_CAP;
}

/**
 * Wrap a promise with a timeout.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise}
 */
async function withTimeout(promise, ms, label) {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
  if (!timeoutMs) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse warchestService CLI args.
 *
 * @param {string[]} argv
 * @param {object} [logger]
 * @returns {{wallets: Array<{alias: string, pubkey: string, color: string|null}>, mode: string}}
 */
function parseArgs(argv, logger) {
  const wallets = [];
  const args = argv.slice(2);
  let mode = 'daemon';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--wallet') {
      const spec = args[i + 1];
      i += 1;
      if (!spec) continue;
      const [alias, pubkey, color] = spec.split(':');
      if (!alias || !pubkey) {
        logger?.warn?.('[HUD] ignoring malformed --wallet spec:', spec);
        continue;
      }
      wallets.push({ alias, pubkey, color: color || null });
    } else if (arg === '-hud' || arg === '--hud') {
      mode = 'hud';
    }
  }

  return { wallets, mode };
}

/**
 * Normalize event price change deltas.
 *
 * @param {object} eventsObj
 * @returns {object|null}
 */
function extractPriceChange(eventsObj) {
  if (!eventsObj || typeof eventsObj !== 'object') return null;
  const slices = ['1m', '5m', '15m', '30m'];
  const res = {};
  for (const key of slices) {
    const delta =
      eventsObj[key] && Number.isFinite(Number(eventsObj[key].priceChangePercentage))
        ? Number(eventsObj[key].priceChangePercentage)
        : null;
    if (delta != null) res[key] = delta;
  }
  return Object.keys(res).length ? res : null;
}

/**
 * Map SolanaTracker token info into HUD-ready metadata.
 *
 * @param {object} info
 * @returns {object|null}
 */
function mapCoinMeta(info) {
  if (!info || typeof info !== 'object') return null;
  const token = info.token || {};
  const pools = Array.isArray(info.pools) ? info.pools : [];
  const primaryPool = pools[0] || null;
  const price =
    (primaryPool && primaryPool.price && Number(primaryPool.price.usd)) ||
    (primaryPool && primaryPool.price && Number(primaryPool.price.quote)) ||
    null;
  const events = info.events || null;
  const priceChanges = extractPriceChange(events);
  const holders = Array.isArray(info.holders) ? info.holders.length : null;

  return {
    mint: token.mint || null,
    name: token.name || token.symbol || null,
    symbol: token.symbol || null,
    priceUsd: Number.isFinite(price) ? price : null,
    events: priceChanges,
    holders,
    lastUpdated: primaryPool && primaryPool.lastUpdated ? Number(primaryPool.lastUpdated) : null,
  };
}

/**
 * Pick the pool with the highest liquidity.
 *
 * @param {Array} pools
 * @returns {object|null}
 */
function pickPrimaryPool(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return null;

  let best = null;
  let bestUsd = -1;

  for (const p of pools) {
    const usd =
      p && p.liquidity && Number.isFinite(Number(p.liquidity.usd))
        ? Number(p.liquidity.usd)
        : Number.isFinite(Number(p && p.liquidityUsd))
          ? Number(p.liquidityUsd)
          : Number.isFinite(Number(p && p.liquidity))
            ? Number(p.liquidity)
            : 0;

    if (usd > bestUsd) {
      bestUsd = usd;
      best = p;
    }
  }

  return best || pools[0] || null;
}

/**
 * Extract curve percentage from pools if present.
 *
 * @param {Array} pools
 * @returns {number|null}
 */
function extractCurvePct(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return null;

  for (const p of pools) {
    if (!p || typeof p !== 'object') continue;
    const v = p.curvePercentage;
    if (Number.isFinite(Number(v))) return Number(v);
  }

  return null;
}

/**
 * Extract risk fields from a token metadata record.
 *
 * @param {object} tokenMetaRow
 * @returns {{riskScore: number|null, top10Pct: number|null, sniperPct: number|null, devPct: number|null, riskTags: Array<string>|null}}
 */
function extractRiskFields(tokenMetaRow) {
  const risk = tokenMetaRow && tokenMetaRow.risk ? tokenMetaRow.risk : null;
  if (!risk || typeof risk !== 'object') {
    return {
      riskScore: null,
      top10Pct: null,
      sniperPct: null,
      devPct: null,
      riskTags: null,
    };
  }

  const riskScore = Number.isFinite(Number(risk.score)) ? Number(risk.score) : null;
  const top10Pct = Number.isFinite(Number(risk.top10)) ? Number(risk.top10) : null;

  const sniperPct =
    risk.snipers && Number.isFinite(Number(risk.snipers.totalPercentage))
      ? Number(risk.snipers.totalPercentage)
      : null;

  const devPct =
    risk.dev && Number.isFinite(Number(risk.dev.percentage))
      ? Number(risk.dev.percentage)
      : null;

  const tagsRaw = Array.isArray(risk.risks) ? risk.risks : [];
  const riskTags = tagsRaw
    .map((r) => (r && r.name ? String(r.name) : null))
    .filter((s) => typeof s === 'string' && s.length > 0);

  return {
    riskScore,
    top10Pct,
    sniperPct,
    devPct,
    riskTags: riskTags.length ? riskTags : null,
  };
}

/**
 * Normalize status category for a tx event.
 *
 * @param {object} event
 * @returns {string}
 */
function deriveStatusCategory(event) {
  if (!event) return 'unknown';
  if (event.statusCategory) return String(event.statusCategory);

  const txSummary = event.txSummary || null;
  if (txSummary && txSummary.statusCategory) return String(txSummary.statusCategory);

  const status = event.status || txSummary?.status || 'unknown';
  if (status === 'confirmed' || status === 'ok') return 'confirmed';
  if (status === 'failed') return 'failed';
  return 'processed';
}

/**
 * Pick a status emoji for the given category.
 *
 * @param {string} cat
 * @returns {string}
 */
function deriveStatusEmoji(cat) {
  if (cat === 'confirmed') return '🟢';
  if (cat === 'failed') return '🔴';
  return '🟡';
}

/**
 * Build a HUD display object for a transaction event.
 *
 * @param {object} event
 * @param {object|null} prev
 * @returns {object|null}
 */
function buildTxDisplay(event, prev) {
  if (!event || typeof event !== 'object') return null;

  const txSummary = event.txSummary || {};
  const statusCategory = deriveStatusCategory(event);
  const statusEmoji =
    event.statusEmoji || txSummary.statusEmoji || prev?.statusEmoji || deriveStatusEmoji(statusCategory);

  const side = txSummary.side || (event.context && event.context.side) || null;
  const mint = txSummary.mint || (event.context && event.context.mint) || prev?.mint || null;
  const wallet = (event.context && event.context.wallet) || prev?.wallet || null;

  const slot =
    txSummary.slot != null
      ? txSummary.slot
      : event.slot != null
        ? event.slot
        : prev?.slot != null
          ? prev.slot
          : null;

  const observedAtParsed =
    (txSummary.blockTimeIso ? Date.parse(txSummary.blockTimeIso) : null) ??
    (txSummary.observedAt ? Date.parse(txSummary.observedAt) : null) ??
    (event.observedAt ? Date.parse(event.observedAt) : null);

  const observedAt =
    (Number.isFinite(observedAtParsed) ? observedAtParsed : null) ??
    (Number.isFinite(prev?.observedAt) ? prev.observedAt : 0);

  const blockTimeIso = txSummary.blockTimeIso || prev?.blockTimeIso || null;
  const tokens = txSummary.tokens != null ? txSummary.tokens : prev?.tokens ?? null;
  const sol = txSummary.sol != null ? txSummary.sol : prev?.sol ?? null;
  const priceImpactPct = txSummary.priceImpactPct != null ? txSummary.priceImpactPct : prev?.priceImpactPct ?? null;
  const totalFeesSol = txSummary.totalFeesSol != null ? txSummary.totalFeesSol : prev?.totalFeesSol ?? null;
  const explorerUrl = txSummary.explorerUrl || prev?.explorerUrl || null;

  return {
    txid: event.txid || txSummary.txid || prev?.txid || null,
    statusCategory,
    statusEmoji,
    side,
    mint,
    wallet,
    slot,
    observedAt,
    blockTimeIso,
    tokens,
    sol,
    priceImpactPct,
    totalFeesSol,
    explorerUrl,
    label: txSummary.label || prev?.label || null,
    errMessage:
      txSummary.errMessage ||
      prev?.errMessage ||
      (event.err && (event.err.message || JSON.stringify(event.err))) ||
      null,
    symbol: txSummary.symbol || prev?.symbol || null,
    coin: prev?.coin || null,
  };
}

/**
 * Create an emit wrapper that rate-limits updates.
 *
 * @param {Function} emitFn
 * @param {number} throttleMs
 * @returns {Function}
 */
function createThrottledEmitter(emitFn, throttleMs) {
  const ms = Number.isFinite(Number(throttleMs)) && Number(throttleMs) > 0 ? Math.trunc(Number(throttleMs)) : 0;
  if (!ms) {
    return () => {
      try { emitFn(); } catch {}
    };
  }

  let last = 0;
  let scheduled = false;

  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      try { emitFn(); } catch {}
      return;
    }
    if (scheduled) return;
    scheduled = true;

    setTimeout(() => {
      scheduled = false;
      last = Date.now();
      try { emitFn(); } catch {}
    }, ms);
  };
}

module.exports = {
  pushServiceAlert,
  withTimeout,
  parseArgs,
  extractPriceChange,
  mapCoinMeta,
  pickPrimaryPool,
  extractCurvePct,
  extractRiskFields,
  deriveStatusCategory,
  deriveStatusEmoji,
  buildTxDisplay,
  createThrottledEmitter,
};
