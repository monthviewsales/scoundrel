'use strict';

const legacy = require('./legacyAdapter');
const recordScTradeEvent = require('./trading/recordScTradeEvent');
const applyScTradeEventToPositions = require('./trading/applyScTradeEventToPositions');
const ensureOpenPositionRun = require('./trading/ensureOpenPositionRun');
const recordPastTradeEvent = require('./trading/recordPastTradeEvent');
const getTradesByTradeUuid = require('./trading/getTradesByTradeUuid');
const getPnlPositionsLive = require('./trading/getPnlPositionsLive');
const getTokenAmtByAlias = require('./trading/getTokenAmtByAlias');

const chalk = require('chalk');
const { logger } = require('./context');

function removed(fnName) {
  return function removedFunction() {
    logger?.warn?.(chalk.bgRed(`[BootyBox] ${fnName} has been removed and is unsupported`));
    return undefined;
  };
}

module.exports = {
  applyScTradeEventToPositions,
  ensureOpenPositionRun,
  recordScTradeEvent,
  getTradesByTradeUuid,
  getPnlPositionsLive,
  recordPastTradeEvent,
  getTradesByTradeUuid,
  getTokenAmtByAlias,
  bulkResyncPositions: legacy.bulkResyncPositions,
  clearPendingSwap: legacy.clearPendingSwap,
  getBootyByMint: legacy.getBootyByMint,
  getHeartbeatSnapshot: legacy.getHeartbeatSnapshot,
  getHighestPriceByMint: legacy.getHighestPriceByMint,
  getPendingSwapCount: legacy.getPendingSwapCount,
  getTokenAmount: legacy.getTokenAmount,
  isSwapPending: legacy.isSwapPending,
  logEvaluation: legacy.logEvaluation,
  markPendingSwap: legacy.markPendingSwap,
  setTradeUuid: legacy.setTradeUuid,
  getTradeUuid: legacy.getTradeUuid,
  clearTradeUuid: legacy.clearTradeUuid,
  updateHighestPrice: legacy.updateHighestPrice,
  addPosition: legacy.addPosition,
  logBuy: removed('logBuy'),
  logSell: removed('logSell'),
  updatePnL: removed('updatePnL'),
  updatePreviousRsi: removed('updatePreviousRsi'),
  removePosition: removed('removePosition'),
  insertTrades: removed('insertTrades'),
  getOpenPositions: removed('getOpenPositions'),
  getLatestBuyByMint: removed('getLatestBuyByMint'),
  getLatestSellByMint: removed('getLatestSellByMint'),
};
