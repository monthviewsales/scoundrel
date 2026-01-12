#!/usr/bin/env node
'use strict';

const baseLogger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');
const { createBuyOpsController } = require('./buyOps/controller');

const buyOpsLogger = createWorkerLogger({
  workerName: 'buyOpsWorker',
  scope: 'buyOps',
  baseLogger,
  includeCallsite: true,
});

/**
 * Start BuyOps via IPC harness.
 * @returns {void}
 */
function startHarness() {
  let controller = null;

  createWorkerHarness(
    async (payload, { env }) => {
      buyOpsLogger.debug(
        `[buyOps] IPC payload received keys=${Object.keys(payload || {}).join(',') || 'none'}`
      );

      controller = createBuyOpsController(payload, { env }, buyOpsLogger);
      return controller.start();
    },
    {
      exitOnComplete: false,
      workerName: 'buyOps',
      logger: buyOpsLogger,
      onClose: async () => {
        if (controller && typeof controller.stop === 'function') {
          await controller.stop('terminated');
        }
      },
    }
  );

  process.on('message', (msg) => {
    if (!msg || msg.type !== 'stop') return;
    if (controller && typeof controller.stop === 'function') {
      controller.stop('stop-request');
    }
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  createBuyOpsController,
  startHarness,
};
