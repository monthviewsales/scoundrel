'use strict';

/**
 * MySQL support has ended. This module remains to preserve import paths
 * but every call warns and throws to prevent silent usage.
 */
const chalk = require('chalk');
const logger = require('../utils/logger');

const MYSQL_FUNCTIONS = [
  'init',
  'ping',
  'close',
  'engine',
  'addOrUpdateCoin',
  'getCoinByMint',
  'getCoinStatus',
  'queryAllCoins',
  'getTopScoringCoin',
  'updateCoinPriceFields',
  'updateCoinStatus',
  'updateLastEvaluated',
  'pruneZeroBuyScoreCoins',
  'getCoinCount',
  'queryEligibleCoinsForBuy',
  'getOpenPositions',
  'addPosition',
  'removePosition',
  'getBootyByMint',
  'getTokenAmount',
  'markPendingSwap',
  'clearPendingSwap',
  'getPendingSwapCount',
  'isSwapPending',
  'bulkResyncPositions',
  'updateHighestPrice',
  'getHighestPriceByMint',
  'updatePreviousRsi',
  'logBuy',
  'logSell',
  'getLatestBuyByMint',
  'getLatestSellByMint',
  'logEvaluation',
  'updatePnL',
  'insertTrades',
  'upsertMarket',
  'cleanupStaleAndResetBuyScores',
  'startSession',
  'endSession',
  'updateSessionStats',
  'getPnLAggregates',
  'getHeartbeatSnapshot',
  'setTradeUuid',
  'getTradeUuid',
  'clearTradeUuid',
  'recordScTradeEvent',
  'applyScTradeEventToPositions',
  'listWarchestWallets',
  'getWarchestWalletByAlias',
  'insertWarchestWallet',
  'updateWarchestWalletOptions',
  'updateWarchestWalletColor',
  'deleteWarchestWallet',
  'getDefaultFundingWallet',
  'listWalletsByUsage',
  'listAutoAttachedWarchestWallets',
  'listFundingWallets',
  'setDefaultFundingWallet',
  'listTrackedKolWallets',
  'upsertKolWalletFromDossier',
  'upsertProfileSnapshot',
  'recordWalletAnalysis',
  'getWalletAnalysisById',
  'listWalletAnalysesByWallet',
  'recordTradeAutopsy',
  'getTradeAutopsyById',
  'listTradeAutopsiesByWallet',
  'recordAsk',
  'recordTune',
  'recordJobRun',
  'getLatestWalletProfileVersion',
  'persistWalletProfileArtifacts',
];

const warnMysqlDisabled = (action) => {
  const message = chalk.bgYellow.black(
    `[BootyBox] MySQL support has ended. Attempted to ${action}. SQLite is now the only supported engine.`
  );
  logger.warn(message);
  return message;
};

const buildDisabledFunction = (name) => {
  return () => {
    const message = warnMysqlDisabled(`call mysql.${name}()`);
    const error = new Error(message);
    error.code = 'BOOTYBOX_MYSQL_DISABLED';
    throw error;
  };
};

const BootyBox = {
  engine: 'mysql',
  init: () => warnMysqlDisabled('initialize the MySQL adapter'),
  ping: () => warnMysqlDisabled('ping the MySQL adapter'),
  close: () => warnMysqlDisabled('close the MySQL adapter'),
};

for (const fnName of MYSQL_FUNCTIONS) {
  if (!BootyBox[fnName]) {
    BootyBox[fnName] = buildDisabledFunction(fnName);
  }
}

module.exports = BootyBox;
