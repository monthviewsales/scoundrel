'use strict';

const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const { createHubCoordinator } = require('../../lib/warchest/hubCoordinator');
const { buildInitialState } = require('../../lib/warchest/client');
const { applyHubEventToState } = require('../../lib/warchest/hudEvents');

const swapWorkerPath = path.join(__dirname, '..', 'fixtures', 'warchest', 'mockSwapWorker.js');

function makeWallet() {
  const kp = Keypair.generate();
  return { secret: bs58.encode(kp.secretKey), pubkey: kp.publicKey.toBase58() };
}

describe('warchest hub coordinator', () => {
  test('routes swap and propagates HUD event', async () => {
    const wallet = makeWallet();

    const coordinator = createHubCoordinator({
      swapWorkerPath,
      lockPrefix: `test-${Date.now()}`,
      commandEnv: {
        swap: {
          DISABLE_HUB_EVENT_WRITE: '1',
        },
      },
    });

    const result = await coordinator.runSwap({
      side: 'buy',
      mint: 'So11111111111111111111111111111111111111112',
      amount: 1,
      walletPrivateKey: wallet.secret,
      walletAlias: 'alpha',
      slippagePercent: 1,
      txid: 'hub-txid',
    });

    const state = buildInitialState([{ alias: 'alpha', pubkey: wallet.pubkey, color: null }]);
    expect(result.event).toBeTruthy();
    applyHubEventToState(state, result.event);
    coordinator.close();

    expect(state.alpha.recentEvents.length).toBeGreaterThan(0);
    expect(state.alpha.recentEvents[0].summary).toMatch(/confirmed|buy/i);
  });
});
