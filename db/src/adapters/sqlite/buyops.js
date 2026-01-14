"use strict";

const {
  insertEvaluation,
  getLatestEvaluationByMint,
  listEvaluationsByMint,
} = require("./evaluations");

const OPS_TYPE = "buyOps";

/**
 * Insert a BuyOps evaluation snapshot into sc_evaluations.
 *
 * @param {Object} record
 * @returns {number}
 */
function insertBuyOpsEvaluation(record) {
  if (!record || !record.walletId || !record.walletAlias || !record.coinMint) {
    throw new Error(
      "insertBuyOpsEvaluation: walletId, walletAlias, and coinMint are required."
    );
  }
  return insertEvaluation({ ...(record || {}), opsType: OPS_TYPE });
}

/**
 * Fetch latest buyOps evaluation for a mint.
 *
 * @param {string} coinMint
 * @returns {Object|null}
 */
function getLatestBuyOpsEvaluationByMint(coinMint) {
  return getLatestEvaluationByMint(coinMint, OPS_TYPE);
}

/**
 * List buyOps evaluations for a mint (latest first).
 *
 * @param {string} coinMint
 * @param {{ limit?: number }} [options]
 * @returns {Object[]}
 */
function listBuyOpsEvaluationsByMint(coinMint, options = {}) {
  return listEvaluationsByMint(coinMint, { ...options, opsType: OPS_TYPE });
}

module.exports = {
  insertBuyOpsEvaluation,
  getLatestBuyOpsEvaluationByMint,
  listBuyOpsEvaluationsByMint,
};
