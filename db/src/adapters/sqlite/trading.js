'use strict';

const legacy = require('./legacyAdapter');

module.exports = {
  applyScTradeEventToPositions: legacy.applyScTradeEventToPositions,
  bulkResyncPositions: legacy.bulkResyncPositions,
  clearPendingSwap: legacy.clearPendingSwap,
  clearTradeUuid: legacy.clearTradeUuid,
  getBootyByMint: legacy.getBootyByMint,
  getHeartbeatSnapshot: legacy.getHeartbeatSnapshot,
  getHighestPriceByMint: legacy.getHighestPriceByMint,
  getLatestBuyByMint: legacy.getLatestBuyByMint,
  getLatestSellByMint: legacy.getLatestSellByMint,
  getOpenPositions: legacy.getOpenPositions,
  getPendingSwapCount: legacy.getPendingSwapCount,
  getTokenAmount: legacy.getTokenAmount,
  getTradeUuid: legacy.getTradeUuid,
  insertTrades: legacy.insertTrades,
  isSwapPending: legacy.isSwapPending,
  logBuy: legacy.logBuy,
  logEvaluation: legacy.logEvaluation,
  logSell: legacy.logSell,
  markPendingSwap: legacy.markPendingSwap,
  recordScTradeEvent: legacy.recordScTradeEvent,
  removePosition: legacy.removePosition,
  setTradeUuid: legacy.setTradeUuid,
  updateHighestPrice: legacy.updateHighestPrice,
  updatePnL: legacy.updatePnL,
  updatePreviousRsi: legacy.updatePreviousRsi,
  addPosition: legacy.addPosition,
};
