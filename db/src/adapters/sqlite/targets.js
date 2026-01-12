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
 * @param {string} [target.vectorStoreId]
 * @param {string} [target.vectorStoreFileId]
 * @param {number} [target.vectorStoreUpdatedAt]
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
    vector_store_id: target.vectorStoreId || null,
    vector_store_file_id: target.vectorStoreFileId || null,
    vector_store_updated_at: Number.isFinite(target.vectorStoreUpdatedAt)
      ? target.vectorStoreUpdatedAt
      : ((target.vectorStoreFileId || target.vectorStoreId) ? now : null),
    confidence: Number.isFinite(target.confidence) ? target.confidence : null,
    score: Number.isFinite(target.score) ? target.score : null,
    mint_verified: target.mintVerified ? 1 : 0,
    created_at: Number.isFinite(target.createdAt) ? target.createdAt : now,
    updated_at: Number.isFinite(target.updatedAt) ? target.updatedAt : now,
    last_checked_at: Number.isFinite(target.lastCheckedAt) ? target.lastCheckedAt : null,
  };

  db.prepare(
    `INSERT INTO sc_targets (
       mint, symbol, name, status, strategy, strategy_id, source, tags, notes,
       vector_store_id, vector_store_file_id, vector_store_updated_at, confidence, score,
       mint_verified, created_at, updated_at, last_checked_at
     ) VALUES (
       @mint, @symbol, @name, @status, @strategy, @strategy_id, @source, @tags, @notes,
       @vector_store_id, @vector_store_file_id, @vector_store_updated_at, @confidence, @score,
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
       vector_store_id = excluded.vector_store_id,
       vector_store_file_id = excluded.vector_store_file_id,
       vector_store_updated_at = excluded.vector_store_updated_at,
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

/**
 * Update vector store tracking fields for a target.
 *
 * @param {string} mint
 * @param {{ vectorStoreId?: string|null, vectorStoreFileId?: string|null, vectorStoreUpdatedAt?: number }} [updates]
 * @returns {object|null}
 */
function updateTargetVectorStore(mint, updates = {}) {
  if (!mint) {
    throw new Error('updateTargetVectorStore: mint is required');
  }
  const now = Date.now();
  const vectorStoreUpdatedAt = Number.isFinite(updates.vectorStoreUpdatedAt)
    ? updates.vectorStoreUpdatedAt
    : now;

  const info = db.prepare(
    `UPDATE sc_targets
     SET vector_store_id = ?,
         vector_store_file_id = ?,
         vector_store_updated_at = ?,
         updated_at = ?
     WHERE mint = ?`
  ).run(
    updates.vectorStoreId || null,
    updates.vectorStoreFileId || null,
    vectorStoreUpdatedAt,
    now,
    mint,
  );

  if (info.changes === 0) {
    return addUpdateTarget({
      mint,
      status: 'new',
      vectorStoreId: updates.vectorStoreId || null,
      vectorStoreFileId: updates.vectorStoreFileId || null,
      vectorStoreUpdatedAt,
      updatedAt: now,
      lastCheckedAt: now,
    });
  }

  return getTarget(mint);
}

function resolvePruneCutoffs(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 2 * 60 * 60 * 1000;
  const archivedTtlMs = Number.isFinite(options.archivedTtlMs) ? options.archivedTtlMs : 7 * 24 * 60 * 60 * 1000;

  return {
    staleCutoff: now - staleMs,
    archivedCutoff: now - archivedTtlMs,
  };
}

/**
 * List stale targets by status + age without deleting them.
 *
 * @param {{ now?: number, staleMs?: number, archivedTtlMs?: number }} [options]
 * @returns {object[]}
 */
function listPrunableTargets(options = {}) {
  const { staleCutoff, archivedCutoff } = resolvePruneCutoffs(options);
  return db.prepare(
    `SELECT * FROM sc_targets
     WHERE status IN ('rejected','avoid')
        OR (status = 'archived' AND (last_checked_at IS NULL OR last_checked_at < @archivedCutoff))
        OR (status NOT IN ('approved','strong_buy','buy','archived','rejected','avoid')
          AND (last_checked_at IS NULL OR last_checked_at < @staleCutoff))`
  ).all({
    staleCutoff,
    archivedCutoff,
  });
}

/**
 * Prune stale targets by status + age.
 *
 * Rules:
 * - approved: never removed
 * - archived: removed after archivedTtlMs
 * - rejected: removed immediately
 * - others: removed after staleMs
 *
 * @param {{ now?: number, staleMs?: number, archivedTtlMs?: number }} [options]
 * @returns {number} number of rows removed
 */
function pruneTargets(options = {}) {
  const { staleCutoff, archivedCutoff } = resolvePruneCutoffs(options);

  const info = db.prepare(
    `DELETE FROM sc_targets
     WHERE status IN ('rejected','avoid')
        OR (status = 'archived' AND (last_checked_at IS NULL OR last_checked_at < @archivedCutoff))
        OR (status NOT IN ('approved','strong_buy','buy','archived','rejected','avoid')
          AND (last_checked_at IS NULL OR last_checked_at < @staleCutoff))`
  ).run({
    staleCutoff,
    archivedCutoff,
  });

  return info.changes || 0;
}

module.exports = {
  addUpdateTarget,
  getTarget,
  removeTarget,
  updateTargetVectorStore,
  listPrunableTargets,
  pruneTargets,
};
