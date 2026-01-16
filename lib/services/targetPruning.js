'use strict';

const BootyBox = require('../../db');
const { queueVectorStoreDelete } = require('../ai/vectorStoreUpload');

/**
 * Prune targets while cleaning up any managed vector store files.
 *
 * @param {{ now?: number, staleMs?: number, archivedTtlMs?: number, logger?: { warn?: Function, info?: Function, debug?: Function } }} [options]
 * @returns {Promise<number>}
 */
async function pruneTargetsWithVectorStoreCleanup(options = {}) {
  const logger = options.logger || console;
  const pruneOptions = {
    now: options.now,
    staleMs: options.staleMs,
    archivedTtlMs: options.archivedTtlMs,
  };

  if (typeof BootyBox.listPrunableTargets !== 'function' || typeof BootyBox.removeTarget !== 'function') {
    if (typeof BootyBox.pruneTargets === 'function') {
      return BootyBox.pruneTargets(pruneOptions);
    }
    return 0;
  }

  const prunable = BootyBox.listPrunableTargets(pruneOptions);
  let removed = 0;

  for (const target of prunable) {
    const mint = target?.mint;
    const fileId = target?.vector_store_file_id;
    if (fileId) {
      try {
        await queueVectorStoreDelete({
          vectorStoreId: target?.vector_store_id || null,
          fileId,
          deleteFile: true,
          source: 'targetscan',
          name: mint || null,
        });
      } catch (err) {
        logger.warn?.('[targets] failed to delete vector store file', {
          mint,
          fileId,
          err: err?.message || err,
        });
      }
    }

    if (mint) {
      try {
        removed += BootyBox.removeTarget(mint);
      } catch (err) {
        logger.warn?.('[targets] failed to remove target', { mint, err: err?.message || err });
      }
    }
  }

  return removed;
}

module.exports = { pruneTargetsWithVectorStoreCleanup };
