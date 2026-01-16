'use strict';

const { ensureBootyBoxInit } = require('../bootyBoxInit');

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

  await ensureBootyBoxInit();
}

/**
 * Persist a snapshot into sc_profiles (final JSON blob).
 * @param {Object} params
 * @param {Object} params.BootyBox
 * @param {string} params.profileId
 * @param {string} params.name
 * @param {string|null} params.wallet
 * @param {string} params.source
 * @param {Object} [params.profile]
 * @param {Object} [params.prompt]
 * @param {Object} [params.response]
 * @param {Object} [params.logger]
 */
async function persistProfileSnapshot({ BootyBox, profileId, name, wallet, source, profile, prompt, response, logger }) {
  if (!profileId) throw new Error('[aiPersistence] persistProfileSnapshot requires profileId');
  if (!source) throw new Error('[aiPersistence] persistProfileSnapshot requires source');

  await ensureDb(BootyBox);

  if (typeof BootyBox.upsertProfileSnapshot !== 'function') {
    throw new Error('[aiPersistence] BootyBox.upsertProfileSnapshot is not available');
  }

  try {
    const finalProfile = profile ?? { prompt, response };
    await BootyBox.upsertProfileSnapshot({
      profileId,
      name,
      wallet,
      source,
      profile: finalProfile,
    });
    logger?.debug?.(`[aiPersistence] archived sc_profiles source=${source} id=${profileId}`);
  } catch (e) {
    logger?.warn?.('[aiPersistence] failed to archive sc_profiles:', e?.message || e);
  }
}

/**
 * Persist coin metadata into sc_coin_metadata (devscan mint payloads).
 * @param {Object} params
 * @param {Object} params.BootyBox
 * @param {string} params.metadataId
 * @param {string} params.mint
 * @param {string} params.source
 * @param {Object|string} params.response
 * @param {Object} [params.logger]
 */
async function persistCoinMetadata({ BootyBox, metadataId, mint, source, response, logger }) {
  if (!metadataId || !mint || !source) {
    throw new Error('[aiPersistence] persistCoinMetadata requires metadataId, mint, and source');
  }

  await ensureDb(BootyBox);

  if (typeof BootyBox.upsertCoinMetadata !== 'function') {
    throw new Error('[aiPersistence] BootyBox.upsertCoinMetadata is not available');
  }

  try {
    await BootyBox.upsertCoinMetadata({
      metadataId,
      mint,
      source,
      response,
    });
    logger?.debug?.(`[aiPersistence] archived sc_coin_metadata mint=${mint} source=${source} id=${metadataId}`);
  } catch (e) {
    logger?.warn?.('[aiPersistence] failed to archive sc_coin_metadata:', e?.message || e);
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
  if (!analysisRow) throw new Error('[aiPersistence] persistWalletAnalysis requires analysisRow');

  await ensureDb(BootyBox);

  if (typeof BootyBox.recordWalletAnalysis !== 'function') {
    throw new Error('[aiPersistence] BootyBox.recordWalletAnalysis is not available');
  }

  try {
    await BootyBox.recordWalletAnalysis(analysisRow);
    logger?.debug?.(`[aiPersistence] persisted wallet analysis id=${analysisRow.analysisId || analysisRow.analysis_id || 'unknown'}`);
  } catch (e) {
    logger?.warn?.('[aiPersistence] failed to persist wallet analysis:', e?.message || e);
    throw e;
  }
}

/**
 * Persist a trade autopsy row (autopsy).
 * @param {Object} params
 * @param {Object} params.BootyBox
 * @param {Object} params.autopsyRow - exact params expected by BootyBox.recordTradeAutopsy
 * @param {Object} [params.logger]
 */
async function persistTradeAutopsy({ BootyBox, autopsyRow, logger }) {
  if (!autopsyRow) throw new Error('[aiPersistence] persistTradeAutopsy requires autopsyRow');

  await ensureDb(BootyBox);

  if (typeof BootyBox.recordTradeAutopsy !== 'function') {
    throw new Error('[aiPersistence] BootyBox.recordTradeAutopsy is not available');
  }

  try {
    await BootyBox.recordTradeAutopsy(autopsyRow);
    logger?.debug?.(`[aiPersistence] persisted trade autopsy id=${autopsyRow.autopsyId || autopsyRow.autopsy_id || 'unknown'}`);
  } catch (e) {
    logger?.warn?.('[aiPersistence] failed to persist trade autopsy:', e?.message || e);
    throw e;
  }
}

module.exports = {
  persistProfileSnapshot,
  persistCoinMetadata,
  persistWalletAnalysis,
  persistTradeAutopsy,
};
