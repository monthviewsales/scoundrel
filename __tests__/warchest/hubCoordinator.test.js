'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const { createHubCoordinator } = require('../../lib/warchest/hubCoordinator');
const { createHubEventFollower } = require('../../lib/warchest/events');
const { buildInitialState } = require('../../lib/warchest/client');
const { applyHubEventToState } = require('../../lib/warchest/hudEvents');

const swapWorkerPath = path.join(__dirname, '..', 'fixtures', 'warchest', 'mockSwapWorker.js');

function makeWallet() {
  const kp = Keypair.generate();
  return { secret: bs58.encode(kp.secretKey), pubkey: kp.publicKey.toBase58() };
}

function waitForFile(target, attempts = 60) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (fs.existsSync(target)) {
        clearInterval(timer);
        resolve();
      } else if (tries >= attempts) {
        clearInterval(timer);
        reject(new Error(`File not created: ${target}`));
      }
    }, 50);
  });
}

describe('warchest hub coordinator', () => {
  test('routes swap into tx monitor and propagates HUD event', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warchest-hub-'));
    const eventPath = path.join(tempDir, 'events.json');
    const wallet = makeWallet();

    const coordinator = createHubCoordinator({
      swapWorkerPath,
      eventPath,
      lockPrefix: `test-${Date.now()}`,
      commandEnv: {
        swap: {
          TX_MONITOR_EVENT_PATH: eventPath,
          SWAP_WORKER_TEST_LOG: path.join(tempDir, 'swap-log.json'),
        },
      },
    });

    await coordinator.runSwap({
      side: 'buy',
      mint: 'So11111111111111111111111111111111111111112',
      amount: 1,
      walletPrivateKey: wallet.secret,
      walletAlias: 'alpha',
      slippagePercent: 1,
      txid: 'hub-txid',
      hudEventPath: eventPath,
    });

    await waitForFile(eventPath);
    const state = buildInitialState([{ alias: 'alpha', pubkey: wallet.pubkey, color: null }]);
    const existing = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    existing.forEach((ev) => applyHubEventToState(state, ev));
    coordinator.close();

    expect(state.alpha.recentEvents.length).toBeGreaterThan(0);
    expect(state.alpha.recentEvents[0].summary).toMatch(/confirmed|buy/i);
  });
});
