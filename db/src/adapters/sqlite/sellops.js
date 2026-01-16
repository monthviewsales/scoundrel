"use strict";

const { logger } = require("./context");
const {
  deleteEvaluationsByTrade,
  getLatestEvaluationByTrade,
  insertEvaluation,
  listEvaluationsByTrade,
  listRecentEvaluations,
  pruneEvaluations,
} = require("./evaluations");

const OPS_TYPE = "sellOps";

/**
 * Insert a SellOps evaluation tick snapshot into sc_evaluations.
 *
 * @param {Object} record
 * @returns {number}
 */
function insertSellOpsEvaluation(record) {
  if (
    !record ||
    !record.walletId ||
    !record.walletAlias ||
    !record.tradeUuid ||
    !record.coinMint
  ) {
    throw new Error(
      "insertSellOpsEvaluation: walletId, walletAlias, tradeUuid, and coinMint are required."
    );
  }
  return insertEvaluation({ ...(record || {}), opsType: OPS_TYPE });
}

/**
 * Fetch the most recent evaluation tick for a trade.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @returns {Object|null}
 */
function getLatestSellOpsEvaluationByTrade(walletId, tradeUuid) {
  return getLatestEvaluationByTrade(walletId, tradeUuid, OPS_TYPE);
}

/**
 * Fetch the most recent trailing stop state for a trade.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @returns {Object|null}
 */
function getLatestSellOpsTrailingStateByTrade(walletId, tradeUuid) {
  if (!walletId || !tradeUuid) return null;
  let evaluation;
  try {
    evaluation = getLatestSellOpsEvaluationByTrade(walletId, tradeUuid);
  } catch (err) {
    logger?.warn?.(
      `[BootyBox][sellops] getLatestSellOpsTrailingStateByTrade DB query error walletId=${walletId} tradeUuid=${tradeUuid} error=${
        err.message || err
      }`
    );
    return null;
  }

  if (!evaluation) return null;

  const payload = evaluation.payload || null;
  let trailing =
    (payload && payload.riskControls && payload.riskControls.trailing) ||
    (payload &&
      payload.evaluation &&
      payload.evaluation.riskControls &&
      payload.evaluation.riskControls.trailing) ||
    (payload &&
      payload.snapshot &&
      payload.snapshot.riskControls &&
      payload.snapshot.riskControls.trailing) ||
    null;

  if (!payload) {
    logger?.warn?.(
      `[BootyBox][sellops] getLatestSellOpsTrailingStateByTrade payload missing walletId=${walletId} tradeUuid=${tradeUuid} id=${evaluation.id}`
    );
  } else if (!trailing && logger && typeof logger.debug === "function") {
    logger.debug(
      `[BootyBox][sellops] getLatestSellOpsTrailingStateByTrade no trailing state walletId=${walletId} tradeUuid=${tradeUuid} id=${evaluation.id}`
    );
  }

  return {
    id: evaluation.id,
    tsMs: evaluation.tsMs,
    walletId,
    tradeUuid,
    trailing,
  };
}

/**
 * Fetch the latest evaluation and trailing state for decision context for a trade.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @returns {Object|null} { evaluation, trailing }
 */
function getLatestSellOpsDecisionContextByTrade(walletId, tradeUuid) {
  try {
    const evaluation = getLatestSellOpsEvaluationByTrade(walletId, tradeUuid);
    if (!evaluation) return null;
    const payload = evaluation.payload;
    let trailing =
      (payload && payload.riskControls && payload.riskControls.trailing) ||
      (payload &&
        payload.evaluation &&
        payload.evaluation.riskControls &&
        payload.evaluation.riskControls.trailing) ||
      (payload &&
        payload.snapshot &&
        payload.snapshot.riskControls &&
        payload.snapshot.riskControls.trailing) ||
      null;
    if (payload !== null && !trailing) {
      logger?.debug?.(
        `[BootyBox][sellops] getLatestSellOpsDecisionContextByTrade no trailing state walletId=${walletId} tradeUuid=${tradeUuid} id=${evaluation.id}`
      );
    }
    if (payload === null) {
      logger?.warn?.(
        `[BootyBox][sellops] getLatestSellOpsDecisionContextByTrade could not read trailing state because payload was null walletId=${walletId} tradeUuid=${tradeUuid} id=${evaluation.id}`
      );
    }
    return { evaluation, trailing };
  } catch (err) {
    logger?.warn?.(
      `[BootyBox][sellops] getLatestSellOpsDecisionContextByTrade error walletId=${walletId} tradeUuid=${tradeUuid} error=${
        err && err.message ? err.message : err
      }`
    );
    return null;
  }
}

/**
 * List evaluation ticks for a trade within a time window.
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @param {Object} [opts]
 * @returns {Object[]}
 */
function listSellOpsEvaluationsByTrade(walletId, tradeUuid, opts = {}) {
  return listEvaluationsByTrade(walletId, tradeUuid, {
    ...opts,
    opsType: OPS_TYPE,
  });
}

/**
 * List recent evaluation ticks for a wallet.
 *
 * @param {number} walletId
 * @param {Object} [opts]
 * @returns {Object[]}
 */
function listRecentSellOpsEvaluations(walletId, opts = {}) {
  return listRecentEvaluations(walletId, { ...opts, opsType: OPS_TYPE });
}

/**
 * Hard delete evaluations for a single trade (useful when cleaning up test data).
 *
 * @param {number} walletId
 * @param {string} tradeUuid
 * @returns {number} number of deleted rows
 */
function deleteSellOpsEvaluationsByTrade(walletId, tradeUuid) {
  return deleteEvaluationsByTrade(walletId, tradeUuid, OPS_TYPE);
}

/**
 * Prune old evaluation rows (optional maintenance).
 *
 * @param {Object} opts
 * @returns {number} number of deleted rows
 */
function pruneSellOpsEvaluations(opts = {}) {
  return pruneEvaluations({ ...opts, opsType: OPS_TYPE });
}

module.exports = {
  insertSellOpsEvaluation,
  getLatestSellOpsEvaluationByTrade,
  getLatestSellOpsTrailingStateByTrade,
  getLatestSellOpsDecisionContextByTrade,
  listSellOpsEvaluationsByTrade,
  listRecentSellOpsEvaluations,
  deleteSellOpsEvaluationsByTrade,
  pruneSellOpsEvaluations,
};
