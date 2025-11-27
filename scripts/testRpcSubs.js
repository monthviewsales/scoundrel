// scripts/testRpcSubs.js
const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
const { createRpcMethods } = require('../lib/solana/rpcMethods');
const logger = require('../lib/logger');

async function main() {
  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
  const methods = createRpcMethods(rpc, rpcSubs);

  logger.info('[WS TEST] Starting...');

  const balance = await rpc.getBalance('So11111111111111111111111111111111111111112').send();
  logger.info('Balance OK', { balance: balance.value });

  // This will NOW WORK
  const slotSub = await methods.subscribeSlot((slot) => {
    logger.info('[SLOT]', { slot: slot.slot, status: slot.status });
  });
  logger.info('slotSubscribe SUCCESS', { id: slotSub.subscriptionId });

  // Auto cleanup
  setTimeout(async () => {
    await slotSub.unsubscribe();
    await close();
    process.exit(0);
  }, 60_000);
}

main().catch(console.error);