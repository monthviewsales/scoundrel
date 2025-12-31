#!/usr/bin/env node
'use strict';

const baseLogger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');
const { createSellOpsController } = require('./sellOps/controller');
const { redact } = require('./sellOps/utils');

const sellOpsLogger = createWorkerLogger({
  workerName: 'sellOpsWorker',
  scope: 'sellOps',
  baseLogger,
  includeCallsite: true,
});

/**
 * Start SellOps via IPC harness.
 */
function startHarness() {
  let controller = null;

  createWorkerHarness(
    async (payload, { track, env }) => {
      // Accept either `{ wallet: { alias } }` or `{ walletAlias }` style payloads.
      const walletAlias = payload?.walletAlias || payload?.alias || payload?.wallet?.alias || payload?.wallet?.walletAlias;
      const walletPubkey = payload?.walletPubkey || payload?.pubkey || payload?.wallet?.pubkey;

      sellOpsLogger.debug(
        `[sellOps] IPC payload received keys=${Object.keys(payload || {}).join(',') || 'none'} ` +
          `walletAlias=${walletAlias || 'n/a'} walletPubkey=${walletPubkey ? String(walletPubkey).slice(0, 6) + '…' : 'n/a'}`
      );

      sellOpsLogger.debug(`[sellOps] IPC payload snapshot ${JSON.stringify(redact(payload || {}))}`);

      sellOpsLogger.debug(
        `[sellOps] env presence WARCHEST_DATA_ENDPOINT=${env?.WARCHEST_DATA_ENDPOINT ? 'yes' : 'no'} ` +
          `SOLANATRACKER_API_KEY=${env?.SOLANATRACKER_API_KEY ? 'yes' : 'no'}`
      );

      controller = createSellOpsController(
        {
          ...payload,
          wallet: payload?.wallet || { alias: walletAlias, pubkey: walletPubkey },
        },
        { track, env }
      );

      return controller.start();
    },
    {
      exitOnComplete: false, // long-lived loop
      workerName: 'sellOps',
      logger: sellOpsLogger,
      metricsReporter: (event) => {
        sellOpsLogger.debug?.(`[sellOps][metrics] ${JSON.stringify(event)}`);
      },
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
  createSellOpsController,
  startHarness,
};
