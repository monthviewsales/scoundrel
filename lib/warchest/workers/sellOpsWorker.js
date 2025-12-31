#!/usr/bin/env node
'use strict';

const logger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createSellOpsController } = require('./sellOps/controller');
const { redact } = require('./sellOps/utils');

// Normalize sellOps logger: supports factory-style (logger.sellOps()) and object-style (logger.sellOps).
// Fall back to the base logger when sellOps scoping is unavailable (tests/mocks).
const sellOpsLogger = (() => {
  if (typeof logger.sellOps === 'function') return logger.sellOps();
  if (logger.sellOps) return logger.sellOps;
  return logger;
})();

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
