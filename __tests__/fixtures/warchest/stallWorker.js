'use strict';

const { createWorkerHarness } = require('../../../lib/warchest/workers/harness');

createWorkerHarness(async () => new Promise(() => {}), { exitOnComplete: false });
