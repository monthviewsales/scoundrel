'use strict';

const { db } = require('../context');

/**
 * Aggregate high-level PnL-related totals from sc_trades.
 *
 * NOTE: This does not attempt to compute realized PnL per position-run yet.
 * It provides gross totals (cost/proceeds/fees) suitable for session summaries and HUD.
 */
function getPnLAggregates() {
  const buys = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(CASE
          WHEN sol_amount IS NOT NULL AND sol_usd_price IS NOT NULL
            THEN ABS(sol_amount) * sol_usd_price
          ELSE 0
        END), 0)                         AS totalCostUsd,
        COALESCE(SUM(COALESCE(token_amount, 0)), 0) AS totalTokens,
        COALESCE(SUM(COALESCE(fees_usd, 0)), 0)     AS totalFeesUsd,
        COUNT(*)                                   AS count
      FROM sc_trades
      WHERE side = 'buy'
      `
    )
    .get();

  const sells = db
    .prepare(
      `
      SELECT
        NULL                                        AS realizedUsd,
        COALESCE(SUM(CASE
          WHEN sol_amount IS NOT NULL AND sol_usd_price IS NOT NULL
            THEN sol_amount * sol_usd_price
          ELSE 0
        END), 0)                         AS grossProceedsUsd,
        COALESCE(SUM(COALESCE(token_amount, 0)), 0) AS totalTokens,
        COALESCE(SUM(COALESCE(fees_usd, 0)), 0)     AS totalFeesUsd,
        COUNT(*)                                   AS count
      FROM sc_trades
      WHERE side = 'sell'
      `
    )
    .get();

  return { buys, sells };
}

module.exports = getPnLAggregates;