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

    // We have proven slotSubscribe works; stop the slot timeout so it
    // doesn't close the client while we are waiting for an account event.
    clearTimeout(timer);

    // --- AccountSubscribe test (wait for a real change) ---
    const testPubkey = process.env.TEST_PUBKEY;
    if (testPubkey && rpcSubs.accountSubscribe) {
      console.log('[testRpcSubs] subscribing to account updates for:', testPubkey);
      const acctSub = rpcSubs.accountSubscribe(testPubkey);
      const acctIterable = await acctSub.subscribe();
      const acctIter = acctIterable[Symbol.asyncIterator]();

      try {
        console.log('[testRpcSubs] waiting for first account event (move some SOL)...');
        const { value: acctValue, done } = await acctIter.next();

        if (done) {
          console.log('[testRpcSubs] iterator completed before any account event');
        } else {
          console.log('[testRpcSubs] first account event (raw):');
          try {
            console.log(JSON.stringify(acctValue, null, 2));
          } catch (_) {
            console.log(acctValue);
          }
        }
      } finally {
        if (typeof acctIterable.return === 'function') await acctIterable.return();
      }
    } else {
      console.log('[testRpcSubs] accountSubscribe not available or no TEST_PUBKEY set');
    }
  } finally {
    clearTimeout(timer);
    if (typeof iterable.return === 'function') await iterable.return();
    await close();

    // Ensure the process terminates once the test is complete when run as a script.
    if (require.main === module) {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[testRpcSubs] fatal error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
