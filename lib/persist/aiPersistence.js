'use strict';

/**
 * Centralized persistence helpers for AI tools.
 * DB is always on; no SAVE_* logic belongs here.
 */

/**
 * Ensure BootyBox is initialized (idempotent).
 * @param {Object} BootyBox
 */
async function ensureDb(BootyBox) {
  if (!BootyBox || typeof BootyBox.init !== 'function') {
    throw new Error('[aiPersistence] BootyBox.init is not available');
  }
  await BootyBox.init();
}

/**
 * Persist a snapshot into sc_profiles (prompt+response shape).
 * @param {Object} params
 * @param {Object} params.BootyBox
 * @param {string} params.profileId
 * @param {string} params.name
 * @param {string|null} params.wallet
 * @param {string} params.source
 * @param {Object} params.prompt
 * @param {Object} params.response
 * @param {Object} [params.logger]
 */
async function persistProfileSnapshot({ BootyBox, profileId, name, wallet, source, prompt, response, logger }) {
  await ensureDb(BootyBox);

  if (typeof BootyBox.upsertProfileSnapshot !== 'function') {
    throw new Error('[aiPersistence] BootyBox.upsertProfileSnapshot is not available');
  }

  try {
    await BootyBox.upsertProfileSnapshot({
      profileId,
      name,
      wallet,
      source,
      profile: { prompt, response },
    });
    logger?.debug?.(`[aiPersistence] archived sc_profiles source=${source} id=${profileId}`);
  } catch (e) {
    logger?.warn?.('[aiPersistence] failed to archive sc_profiles:', e?.message || e);
  }
}

/**
 * Persist a wallet analysis row (dossier).
 * @param {Object} params
 * @param {Object} params.BootyBox
 * @param {Object} params.analysisRow - exact params expected by BootyBox.recordWalletAnalysis
 * @param {Object} [params.logger]
 */
async function persistWalletAnalysis({ BootyBox, analysisRow, logger }) {
  await ensureDb(BootyBox);

  if (typeof BootyBox.recordWalletAnalysis !== 'function') {
    throw new Error('[aiPersistence] BootyBox.recordWalletAnalysis is not available');
  }

  await BootyBox.recordWalletAnalysis(analysisRow);
  logger?.debug?.(`[aiPersistence] persisted wallet analysis id=${analysisRow.analysisId || analysisRow.analysis_id || 'unknown'}`);
}

/**
 * Persist a trade autopsy row (autopsy).
 * @param {Object} params
 * @param {Object} params.BootyBox
 * @param {Object} params.autopsyRow - exact params expected by BootyBox.recordTradeAutopsy
 * @param {Object} [params.logger]
 */
async function persistTradeAutopsy({ BootyBox, autopsyRow, logger }) {
  await ensureDb(BootyBox);

  if (typeof BootyBox.recordTradeAutopsy !== 'function') {
    throw new Error('[aiPersistence] BootyBox.recordTradeAutopsy is not available');
  }

  await BootyBox.recordTradeAutopsy(autopsyRow);
  logger?.debug?.(`[aiPersistence] persisted trade autopsy id=${autopsyRow.autopsyId || autopsyRow.autopsy_id || 'unknown'}`);
}

module.exports = {
  persistProfileSnapshot,
  persistWalletAnalysis,
  persistTradeAutopsy,
};