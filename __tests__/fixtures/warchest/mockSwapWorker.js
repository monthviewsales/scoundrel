'use strict';

const { createWorkerHarness } = require('../../../lib/warchest/workers/harness');
const { appendHubEvent } = require('../../../lib/warchest/events');

createWorkerHarness(async (payload) => {
  const txid = payload.txid || 'stub-txid';
  const eventPath = process.env.TX_MONITOR_EVENT_PATH || payload.hudEventPath;

  if (process.env.SWAP_WORKER_TEST_LOG) {
    const logPath = process.env.SWAP_WORKER_TEST_LOG;
    const logPayload = { txid, eventPath, envEventPath: process.env.TX_MONITOR_EVENT_PATH };
    require('fs').writeFileSync(logPath, JSON.stringify(logPayload, null, 2), 'utf8');
  }

  appendHubEvent(
    {
      txid,
      status: 'confirmed',
      context: {
        wallet: payload.walletAlias || payload.wallet,
        mint: payload.mint || null,
        side: payload.side || null,
      },
      observedAt: new Date().toISOString(),
    },
    eventPath,
  );

  return {
    txid,
    signature: 'stub-sig',
    slot: 1,
    walletPubkey: payload.wallet || payload.walletAlias || null,
  };
});
