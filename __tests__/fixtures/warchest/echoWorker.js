'use strict';

const { createWorkerHarness } = require('../../../lib/warchest/workers/harness');

createWorkerHarness(async (payload) => {
  if (payload && payload.sleepMs) {
    await new Promise((resolve) => setTimeout(resolve, payload.sleepMs));
  }

  return {
    echo: payload,
    env: {
      rpc: process.env.WARCHEST_RPC_ENDPOINT,
      data: process.env.WARCHEST_DATA_ENDPOINT,
      wallets: process.env.WARCHEST_WALLET_IDS,
      booty: process.env.WARCHEST_BOOTYBOX_PATH,
      extra: process.env.EXTRA_SAMPLE_VAR,
    },
  };
}, { workerName: 'test.echoWorker' });
