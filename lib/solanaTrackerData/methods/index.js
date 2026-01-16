"use strict";

const { createGetTokenInformation } = require("./getTokenInformation");
const { createGetTokenByPoolAddress } = require("./getTokenByPoolAddress");
const { createGetTokenHoldersTop100 } = require("./getTokenHoldersTop100");
const { createGetLatestTokens } = require("./getLatestTokens");
const { createGetMultipleTokens } = require("./getMultipleTokens");
const { createGetTrendingTokens } = require("./getTrendingTokens");
const {
  createGetTopPerformersByTimeframe,
} = require("./getTopPerformersByTimeframe");
const {
  createGetTokensByVolumeWithTimeframe,
} = require("./getTokensByVolumeWithTimeframe");
const { createGetTokenOverview } = require("./getTokenOverview");
const { createGetTokenPrice } = require("./getTokenPrice");
const { createGetMultipleTokenPrices } = require("./getMultipleTokenPrices");
const { createGetWalletTokens } = require("./getWalletTokens");
const {
  createGetBasicWalletInformation,
} = require("./getBasicWalletInformation");
const { createGetWalletTrades } = require("./getWalletTrades");
const { createGetUserTokenTrades } = require("./getUserTokenTrades");
const { createGetWalletChart } = require("./getWalletChart");
const { createGetTokenOhlcvData } = require("./getTokenOhlcvData");
const { createGetTokenPoolOhlcvData } = require("./getTokenPoolOhlcvData");
const { createGetWalletPnl } = require("./getWalletPnl");
const { createGetTopTradersForToken } = require("./getTopTradersForToken");
const { createGetTokenEvents } = require("./getTokenEvents");
const { createGetPriceRange } = require("./getPriceRange");
const { createGetTokenPnl } = require("./getTokenPnl");
const { createGetAthPrice } = require("./getAthPrice");
const { createSearchTokens } = require("./searchTokens");
const { createGetTokenSnapshotAt } = require("./getTokenSnapshotAt");
const { createGetTokenSnapshotNow } = require("./getTokenSnapshotNow");
const { createHealthCheck } = require("./healthCheck");

/**
 * Bind every supported Data API helper.
 *
 * @param {{ client: any, call: Function, log: any }} deps
 * @returns {Record<string, Function>}
 */
function createDataMethods(deps) {
  return {
    getTokenInformation: createGetTokenInformation(deps),
    getTokenByPoolAddress: createGetTokenByPoolAddress(deps),
    getTokenHoldersTop100: createGetTokenHoldersTop100(deps),
    getLatestTokens: createGetLatestTokens(deps),
    getMultipleTokens: createGetMultipleTokens(deps),
    getTrendingTokens: createGetTrendingTokens(deps),
    getTopPerformersByTimeframe: createGetTopPerformersByTimeframe(deps),
    getTokensByVolumeWithTimeframe: createGetTokensByVolumeWithTimeframe(deps),
    getTokenOverview: createGetTokenOverview(deps),
    getTokenPrice: createGetTokenPrice(deps),
    getMultipleTokenPrices: createGetMultipleTokenPrices(deps),
    getWalletTokens: createGetWalletTokens(deps),
    getBasicWalletInformation: createGetBasicWalletInformation(deps),
    getWalletTrades: createGetWalletTrades(deps),
    getUserTokenTrades: createGetUserTokenTrades(deps),
    getWalletChart: createGetWalletChart(deps),
    getWalletPortfolioChart: createGetWalletChart(deps),
    getTokenOhlcvData: createGetTokenOhlcvData(deps),
    getTokenPoolOhlcvData: createGetTokenPoolOhlcvData(deps),
    getWalletPnl: createGetWalletPnl(deps),
    getPriceRange: createGetPriceRange(deps),
    getTokenPnL: createGetTokenPnl(deps),
    getAthPrice: createGetAthPrice(deps),
    getTopTradersForToken: createGetTopTradersForToken(deps),
    getTokenEvents: createGetTokenEvents(deps),
    searchTokens: createSearchTokens(deps),
    getTokenSnapshotAt: createGetTokenSnapshotAt(deps),
    getTokenSnapshotNow: createGetTokenSnapshotNow(deps),
    healthCheck: createHealthCheck(deps),
  };
}

module.exports = { createDataMethods };
