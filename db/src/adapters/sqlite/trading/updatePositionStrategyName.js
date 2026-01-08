'use strict';

const { db, logger } = require('../context');

/**
 * Update the strategy name for a position if none is assigned yet.
 *
 * @param {Object} params
 * @param {number} params.positionId
 * @param {string} params.strategyName
 * @returns {{ updated: boolean, changes: number }}
 */
function updatePositionStrategyName(params) {
  if (!db) throw new Error('[BootyBox] updatePositionStrategyName: db is not available from context');
  if (typeof db.prepare !== 'function') {
    throw new Error('[BootyBox] updatePositionStrategyName requires a sqlite db instance');
  }

  const positionId = params?.positionId;
  const strategyName = typeof params?.strategyName === 'string' ? params.strategyName.trim() : null;

  if (!positionId || !strategyName) {
    return { updated: false, changes: 0 };
  }

  const stmt = db.prepare(`
    UPDATE sc_positions
    SET
      strategy_name = @strategy_name,
      last_updated_at = @last_updated_at
    WHERE position_id = @position_id
      AND (strategy_name IS NULL OR TRIM(strategy_name) = '')
  `);

  const info = stmt.run({
    position_id: positionId,
    strategy_name: strategyName,
    last_updated_at: Date.now(),
  });

  const changes = info && Number.isFinite(Number(info.changes)) ? Number(info.changes) : 0;

  if (changes && process.env.SC_SQLITE_DIAGNOSTICS === '1') {
    logger?.debug?.(
      `[BootyBox] updatePositionStrategyName position_id=${positionId} strategy_name=${strategyName}`
    );
  }

  return { updated: changes > 0, changes };
}

module.exports = updatePositionStrategyName;
