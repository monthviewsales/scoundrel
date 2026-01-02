'use strict';

const fs = require('fs');
const path = require('path');
const { createWorkerHarness } = require('../../../lib/warchest/workers/harness');

createWorkerHarness(async (payload) => {
  if (process.env.TX_MONITOR_TEST_LOG) {
    const logPath = path.resolve(process.env.TX_MONITOR_TEST_LOG);
    fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), 'utf8');
  }
  return { status: 'confirmed', slot: 999 };
}, { workerName: 'test.txMonitorWorker' });
