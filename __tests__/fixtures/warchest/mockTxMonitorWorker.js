'use strict';

const { createWorkerHarness } = require('../../../lib/warchest/workers/harness');

createWorkerHarness(async (payload) => {
  return { status: 'confirmed', slot: 999, echoedPayload: payload };
}, { workerName: 'test.txMonitorWorker' });
