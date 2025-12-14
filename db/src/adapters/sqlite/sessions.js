'use strict';

// Sessions adapter (sqlite)
// Stable surface area for session lifecycle after legacyAdapter extraction.
// All session modules now live under ./session/*.

const startSession = require('./session/startSession');
const endSession = require('./session/endSession');
const updateSessionStats = require('./session/updateSessionStats');
const getPnlAggregates = require('./session/getPnlAggregates');
const getActiveSession = require('./session/getActiveSession');
const getActiveSessionId = require('./session/getActiveSessionId');

// Back-compat aliases (older code may still reference these names)
const stopSession = endSession;
const heartbeatSession = updateSessionStats;

module.exports = {
  // canonical
  startSession,
  endSession,
  updateSessionStats,
  getPnlAggregates,
  getActiveSession,
  getActiveSessionId,

  // aliases
  stopSession,
  heartbeatSession,
};
