"use strict";

const os = require('os');
const { getChainState } = require('../solana/rpcMethods/internal/chainState');

const LOOP_INTERVAL_MS = 1000;
let lastLoopCheck = Date.now();
let eventLoopLagMs = 0;

const loopMonitor = setInterval(() => {
  const now = Date.now();
  const drift = now - lastLoopCheck - LOOP_INTERVAL_MS;
  eventLoopLagMs = drift > 0 ? drift : 0;
  lastLoopCheck = now;
}, LOOP_INTERVAL_MS);
if (typeof loopMonitor.unref === 'function') {
  loopMonitor.unref();
}

/**
 * Update health metrics for the warchest worker.
 * @param {Record<string, import('../../scripts/warchestHudWorker').WalletState>} state
 * @param {{lastSolMs:number|null,lastTokenMs:number|null,lastDataApiMs:number|null}} rpcStats
 */
function updateHealth(state, rpcStats) {
  const now = Date.now();
  const mem = process.memoryUsage();
  const chain = getChainState();

  const aliases = Object.keys(state || {});
  let staleCount = 0;
  for (const alias of aliases) {
    const w = state[alias];
    if (!w || !w.lastActivityTs) continue;
    if (now - w.lastActivityTs > 60_000) {
      staleCount += 1;
    }
  }

  const lastSlotAt = chain && chain.lastSlotAt ? chain.lastSlotAt : null;

  const health = {
    process: {
      uptimeSec: Math.floor(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      loadAvg1m: os.loadavg()[0],
      eventLoopLagMs,
    },
    rpc: {
      lastSolMs: rpcStats && typeof rpcStats.lastSolMs === 'number' ? rpcStats.lastSolMs : null,
      lastTokenMs: rpcStats && typeof rpcStats.lastTokenMs === 'number' ? rpcStats.lastTokenMs : null,
      lastDataApiMs: rpcStats && typeof rpcStats.lastDataApiMs === 'number' ? rpcStats.lastDataApiMs : null,
    },
    ws: {
      slot: chain && chain.slot != null ? chain.slot : null,
      root: chain && chain.root != null ? chain.root : null,
      lastSlotAgeMs: lastSlotAt ? now - lastSlotAt : null,
    },
    wallets: {
      count: aliases.length,
      staleCount,
    },
    updatedAt: now,
  };

  return health;
}

module.exports = { updateHealth };
