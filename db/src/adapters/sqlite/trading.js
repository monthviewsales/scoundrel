'use strict';

const legacy = require('./legacyAdapter');
const recordScTradeEvent = require('./trading/recordScTradeEvent');
const applyScTradeEventToPositions = require('./trading/applyScTradeEventToPositions');
const ensureOpenPositionRun = require('./trading/ensureOpenPositionRun');
const recordPastTradeEvent = require('./trading/recordPastTradeEvent');
const getTradesByTradeUuid = require('./trading/getTradesByTradeUuid');

const chalk = require('chalk');
const { logger } = require('./context');

function removed(fnName) {
  return function removedFunction() {
    logger?.warn?.(chalk.bgRed(`[BootyBox] ${fnName} has been removed and is unsupported`));
    return undefined;
  };
}

module.exports = {
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
  logEvaluation: legacy.logEvaluation,
  markPendingSwap: legacy.markPendingSwap,
  removePosition: legacy.removePosition,
  setTradeUuid: legacy.setTradeUuid,
  updateHighestPrice: legacy.updateHighestPrice,
  updatePreviousRsi: legacy.updatePreviousRsi,
  addPosition: legacy.addPosition,
  logBuy: removed('logBuy'),
  logSell: removed('logSell'),
  updatePnL: removed('updatePnL'),
  applyScTradeEventToPositions,
  ensureOpenPositionRun,
  recordScTradeEvent,
  getTradesByTradeUuid,
  recordPastTradeEvent,
};
