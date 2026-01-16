'use strict';

const { db } = require('./context');

/**
 * Upsert coin metadata by mint.
 *
 * @param {Object} params
 * @param {string} params.metadataId
 * @param {string} params.mint
 * @param {string} params.source
 * @param {Object|string} params.response
 * @returns {Object|null}
 */
function upsertCoinMetadata({ metadataId, mint, source, response }) {
  if (!metadataId || !mint || !source) {
    throw new Error('upsertCoinMetadata: metadataId, mint, and source required');
  }

  const now = Date.now();
  const serialized = typeof response === 'string' ? response : JSON.stringify(response ?? null);

  db.prepare(
    `INSERT INTO sc_coin_metadata (
       metadata_id, mint, source, response_json, created_at, updated_at
     ) VALUES (
       @metadata_id, @mint, @source, @response_json, @created_at, @updated_at
     )
     ON CONFLICT(mint, source) DO UPDATE SET
       response_json = excluded.response_json,
       updated_at = excluded.updated_at`
  ).run({
    metadata_id: metadataId,
    mint,
    source,
    response_json: serialized,
    created_at: now,
    updated_at: now,
  });

  return getCoinMetadataByMint(mint, source);
}

/**
 * Fetch coin metadata by mint.
 *
 * @param {string} mint
 * @param {string} [source]
 * @returns {Object|null}
 */
function getCoinMetadataByMint(mint, source) {
  if (!mint) return null;
  if (source) {
    return db
      .prepare('SELECT * FROM sc_coin_metadata WHERE mint = ? AND source = ?')
      .get(mint, source) || null;
  }

  return db
    .prepare('SELECT * FROM sc_coin_metadata WHERE mint = ? ORDER BY updated_at DESC LIMIT 1')
    .get(mint) || null;
}

module.exports = {
  upsertCoinMetadata,
  getCoinMetadataByMint,
};
