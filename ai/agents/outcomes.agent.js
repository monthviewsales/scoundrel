/**
 * Outcomes Agent (deterministic)
 * Computes realized outcomes and simple risk signals from the merged payload.
 * Pure Node (no LLM). CommonJS.
 */

const { computeOutcomesFromMintMap } = require('../../lib/analysis/techniqueOutcomes');
const baseLog = require('../../lib/log');

const log = {
  debug: (...a) => baseLog.debug('[outcomes]', ...a),
  info:  (...a) => baseLog.info('[outcomes]', ...a),
  warn:  (...a) => baseLog.warn('[outcomes]', ...a),
  error: (...a) => baseLog.error('[outcomes]', ...a),
};

/**
 * @param {Object} opts
 * @param {Object} opts.merged - merged payload from harvestWallet
 * @returns {Promise<{ winRate:number|null, medianExitPct:number|null, p75ExitPct:number|null, medianHoldMins:number|null, spikeDays:Array<{date:string|null,pnlPct:number}> }>} 
 */
async function computeOutcomes({ merged }) {
  if (!merged || typeof merged !== 'object') {
    throw new Error('computeOutcomes: merged payload is required');
  }

  const mintMap = merged.userTokenTradesByMint || merged.mintTradesByMint || {};
  const chart = Array.isArray(merged.chart) ? merged.chart : null;

  const out = computeOutcomesFromMintMap(mintMap, chart);
  log.debug('computed outcomes:', out);
  return out;
}

module.exports = { computeOutcomes };