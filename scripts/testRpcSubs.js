#!/usr/bin/env node

require('dotenv').config();
const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');

async function main() {
  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();

  console.log('[testRpcSubs] HTTP RPC URL:', process.env.SOLANATRACKER_RPC_HTTP_URL);
  const version = await rpc.getVersion().send();
  console.log('[testRpcSubs] getVersion:', version);

  if (!rpcSubs) {
    console.error('[testRpcSubs] rpcSubs unavailable (missing WS URL)');
    await close();
    return;
  }

  console.log('[testRpcSubs] subscribing to slot updates...');
  const subscription = rpcSubs.slotSubscribe();
  const iterable = await subscription.subscribe();
  const iterator = iterable[Symbol.asyncIterator]();

  const timer = setTimeout(() => {
    console.error('[testRpcSubs] timed out waiting for a slot notification');
    if (typeof iterable.return === 'function') iterable.return().catch(() => {});
    close().catch(() => {});
  }, 15000);

  try {
    const { value } = await iterator.next();
    console.log('[testRpcSubs] first slot event:', value);
  } finally {
    clearTimeout(timer);
    if (typeof iterable.return === 'function') await iterable.return();
    await close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[testRpcSubs] fatal error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
