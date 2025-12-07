'use strict';

const legacy = require('./legacyAdapter');

module.exports = {
  endSession: legacy.endSession,
  getPnLAggregates: legacy.getPnLAggregates,
  startSession: legacy.startSession,
  updateSessionStats: legacy.updateSessionStats,
};
