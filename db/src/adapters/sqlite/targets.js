'use strict';

const { db } = require('./context');

/**
 * Insert or update a target entry by mint.
 *
 * @param {Object} target
 * @param {string} target.mint
 * @param {string} [target.symbol]
 * @param {string} [target.name]
 * @param {string} [target.status]
 * @param {string} [target.strategy]
 * @param {string} [target.strategyId]
 * @param {string} [target.source]
 * @param {string} [target.tags]
 * @param {string} [target.notes]
 * @param {number} [target.confidence]
 * @param {number} [target.score]
 * @param {boolean} [target.mintVerified]
 * @param {number} [target.createdAt]
 * @param {number} [target.updatedAt]
 * @param {number} [target.lastCheckedAt]
 * @returns {object}
 */
function addUpdateTarget(target) {
  if (!target || !target.mint) {
    throw new Error('addUpdateTarget: mint is required');
  }

  const now = Date.now();
  const payload = {
    mint: String(target.mint),
    symbol: target.symbol || null,
    name: target.name || null,
    status: target.status || 'new',
    strategy: target.strategy || null,
    strategy_id: target.strategyId || null,
    source: target.source || null,
    tags: target.tags || null,
    notes: target.notes || null,
    confidence: Number.isFinite(target.confidence) ? target.confidence : null,
    score: Number.isFinite(target.score) ? target.score : null,
    mint_verified: target.mintVerified ? 1 : 0,
    created_at: Number.isFinite(target.createdAt) ? target.createdAt : now,
    updated_at: Number.isFinite(target.updatedAt) ? target.updatedAt : now,
    last_checked_at: Number.isFinite(target.lastCheckedAt) ? target.lastCheckedAt : null,
  };

  db.prepare(
    `INSERT INTO sc_targets (
       mint, symbol, name, status, strategy, strategy_id, source, tags, notes, confidence, score,
       mint_verified, created_at, updated_at, last_checked_at
     ) VALUES (
       @mint, @symbol, @name, @status, @strategy, @strategy_id, @source, @tags, @notes, @confidence, @score,
       @mint_verified, @created_at, @updated_at, @last_checked_at
     )
     ON CONFLICT(mint) DO UPDATE SET
       symbol = excluded.symbol,
       name = excluded.name,
       status = excluded.status,
       strategy = excluded.strategy,
       strategy_id = excluded.strategy_id,
       source = excluded.source,
       tags = excluded.tags,
       notes = excluded.notes,
       confidence = excluded.confidence,
       score = excluded.score,
       mint_verified = excluded.mint_verified,
       updated_at = excluded.updated_at,
       last_checked_at = excluded.last_checked_at`
  ).run(payload);

  return getTarget(payload.mint);
}

/**
 * Get a target by mint.
 *
 * @param {string} mint
 * @returns {object|null}
 */
function getTarget(mint) {
  if (!mint) return null;
  const row = db.prepare('SELECT * FROM sc_targets WHERE mint = ?').get(mint);
  return row || null;
}

/**
 * Remove a target by mint.
 *
 * @param {string} mint
 * @returns {number} number of rows removed
 */
function removeTarget(mint) {
  if (!mint) return 0;
  const info = db.prepare('DELETE FROM sc_targets WHERE mint = ?').run(mint);
  return info.changes || 0;
}

module.exports = {
  addUpdateTarget,
  getTarget,
  removeTarget,
};
