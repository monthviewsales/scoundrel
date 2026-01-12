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
  silentConsole: false,
});

/**
 * Start BuyOps via IPC harness.
 * @returns {void}
 */
function startHarness() {
  let controller = null;

  process.on('unhandledRejection', (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    buyOpsLogger.error(`[buyOps] unhandledRejection: ${message}`);
    if (reason && reason.stack) buyOpsLogger.error(reason.stack);
  });

  process.on('uncaughtException', (err) => {
    const message = err && err.message ? err.message : String(err);
    buyOpsLogger.error(`[buyOps] uncaughtException: ${message}`);
    if (err && err.stack) buyOpsLogger.error(err.stack);
  });

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
