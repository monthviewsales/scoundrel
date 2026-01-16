'use strict';

const baseLogger = require('../logger');
const scopedLogger = typeof baseLogger.child === 'function'
  ? baseLogger.child({ scope: 'tokenBouncer' })
  : baseLogger;

/**
 * Resolve a scoped logger for token bouncer output.
 *
 * @param {{ child?: Function }|null} input
 * @returns {{ info?: Function }}
 */
function resolveLogger(input) {
  if (input && typeof input.child === 'function') {
    try {
      return input.child({ scope: 'tokenBouncer' });
    } catch (_) {
      return input;
    }
  }
  return input || scopedLogger;
}

// ---- Rule thresholds (edit here) ----
const BOUNCE_MUTABLE = true;
const BOUNCE_PUMPFUN_MAYHEM = true;
const MAX_SNIPER_PERCENT = 10;
const MAX_DEV_PERCENT = 15;
const MAX_INSIDER_PERCENT = 22;
const MAX_TOP10_PERCENT = 22;
const MIN_TOTAL_TRADING_SOL = 0.01;
const BOUNCE_RUGGED = true;

/**
 * Resolve a friendly token identifier for logs.
 *
 * @param {object} token
 * @returns {string}
 */
function resolveTokenLabel(token) {
  if (!token || typeof token !== 'object') return 'unknown';
  return token.mint || token.symbol || token.name || 'unknown';
}

/**
 * Extract the token object from a payload entry.
 *
 * @param {object} entry
 * @returns {object}
 */
function getToken(entry) {
  if (!entry || typeof entry !== 'object') return {};
  return entry.token && typeof entry.token === 'object' ? entry.token : entry;
}

/**
 * Resolve token supply for percent calculations.
 *
 * @param {object} entry
 * @returns {number|null}
 */
function getTokenSupply(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const direct = Number(entry.tokenSupply);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const pools = Array.isArray(entry.pools) ? entry.pools : [];
  for (const pool of pools) {
    const supply = Number(pool && pool.tokenSupply);
    if (Number.isFinite(supply) && supply > 0) return supply;
  }
  return null;
}

/**
 * Determine whether pumpfun mayhem mode is present.
 *
 * @param {object} entry
 * @returns {boolean}
 */
function hasPumpfunMayhem(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const pools = entry.pools;
  if (pools && typeof pools === 'object' && !Array.isArray(pools)) {
    const mayhem = pools['pumpfun-amm'] && pools['pumpfun-amm'].isMayhemMode;
    return Boolean(mayhem);
  }
  if (!Array.isArray(pools)) return false;
  return pools.some((pool) => {
    if (!pool || typeof pool !== 'object') return false;
    if (pool['pumpfun-amm'] && pool['pumpfun-amm'].isMayhemMode) return true;
    if (pool.market === 'pumpfun-amm' && pool['pumpfun-amm'] && pool['pumpfun-amm'].isMayhemMode) return true;
    return false;
  });
}

/**
 * Return sniper percentage when available.
 *
 * @param {object} entry
 * @returns {number|null}
 */
function getSniperPercent(entry) {
  const risk = entry && entry.risk ? entry.risk : null;
  const snipers = risk && risk.snipers ? risk.snipers : null;
  const pct = snipers && typeof snipers.totalPercentage === 'number' ? snipers.totalPercentage : null;
  if (pct != null) return pct;

  const totalBalance = snipers && typeof snipers.totalBalance === 'number' ? snipers.totalBalance : null;
  const supply = getTokenSupply(entry);
  if (totalBalance != null && supply && supply > 0) {
    return (totalBalance / supply) * 100;
  }
  return null;
}

/**
 * Determine if a token should be bounced.
 *
 * @param {object} entry
 * @returns {{ bounced: boolean, reason: string|null }}
 */
function shouldBounceToken(entry) {
  const token = getToken(entry);
  const risk = entry && entry.risk ? entry.risk : null;

  if (BOUNCE_MUTABLE && token.isMutable === true) {
    return { bounced: true, reason: 'token.isMutable true' };
  }

  if (BOUNCE_PUMPFUN_MAYHEM && hasPumpfunMayhem(entry)) {
    return { bounced: true, reason: 'pumpfun-amm isMayhemMode true' };
  }

  const sniperPct = getSniperPercent(entry);
  if (typeof sniperPct === 'number' && sniperPct > MAX_SNIPER_PERCENT) {
    return { bounced: true, reason: `snipers.totalBalance > ${MAX_SNIPER_PERCENT}%` };
  }

  const devPct = risk && risk.dev && typeof risk.dev.percentage === 'number'
    ? risk.dev.percentage
    : null;
  if (typeof devPct === 'number' && devPct > MAX_DEV_PERCENT) {
    return { bounced: true, reason: `risk.dev.percentage > ${MAX_DEV_PERCENT}%` };
  }

  const insiderPct = risk && risk.insiders && typeof risk.insiders.totalPercentage === 'number'
    ? risk.insiders.totalPercentage
    : null;
  if (typeof insiderPct === 'number' && insiderPct > MAX_INSIDER_PERCENT) {
    return { bounced: true, reason: `risk.insiders.totalPercentage > ${MAX_INSIDER_PERCENT}%` };
  }

  const top10 = risk && typeof risk.top10 === 'number' ? risk.top10 : null;
  if (typeof top10 === 'number' && top10 > MAX_TOP10_PERCENT) {
    return { bounced: true, reason: `risk.top10 > ${MAX_TOP10_PERCENT}%` };
  }

  const totalTrading = risk && risk.fees && typeof risk.fees.totalTrading === 'number'
    ? risk.fees.totalTrading
    : null;
  if (typeof totalTrading === 'number' && totalTrading < MIN_TOTAL_TRADING_SOL) {
    return { bounced: true, reason: `risk.fees.totalTrading < ${MIN_TOTAL_TRADING_SOL} SOL` };
  }

  if (BOUNCE_RUGGED && risk && risk.rugged === true) {
    return { bounced: true, reason: 'risk.rugged true' };
  }

  return { bounced: false, reason: null };
}

/**
 * Filter tokens by hard rules. Logs a single line per bounced token.
 *
 * @param {object|object[]} input
 * @param {{ logger?: { info?: Function } }} [options]
 * @returns {object|object[]|null}
 */
function bounceTokens(input, options = {}) {
  const logger = resolveLogger(options.logger);
  const logBounce = (entry, reason) => {
    const label = resolveTokenLabel(getToken(entry));
    logger?.info?.(`token: ${label} BOUNCED! ${reason}`);
  };

  if (Array.isArray(input)) {
    const kept = [];
    for (const entry of input) {
      const verdict = shouldBounceToken(entry);
      if (verdict.bounced) {
        logBounce(entry, verdict.reason || 'rule');
      } else {
        kept.push(entry);
      }
    }
    return kept;
  }

  if (!input || typeof input !== 'object') return null;
  const verdict = shouldBounceToken(input);
  if (verdict.bounced) {
    logBounce(input, verdict.reason || 'rule');
    return null;
  }
  return input;
}

module.exports = {
  bounceTokens,
  shouldBounceToken,
};
