'use strict';

const legacy = require('./legacyAdapter');

module.exports = {
  addOrUpdateCoin: legacy.addOrUpdateCoin,
  cleanupStaleAndResetBuyScores: legacy.cleanupStaleAndResetBuyScores,
  getCoinByMint: legacy.getCoinByMint,
  getCoinCount: legacy.getCoinCount,
  getCoinStatus: legacy.getCoinStatus,
  getTopScoringCoin: legacy.getTopScoringCoin,
  queryAllCoins: legacy.queryAllCoins,
  queryEligibleCoinsForBuy: legacy.queryEligibleCoinsForBuy,
  updateCoinPriceFields: legacy.updateCoinPriceFields,
  updateCoinStatus: legacy.updateCoinStatus,
  updateLastEvaluated: legacy.updateLastEvaluated,
  pruneZeroBuyScoreCoins: legacy.pruneZeroBuyScoreCoins,
  upsertMarket: legacy.upsertMarket,
};
