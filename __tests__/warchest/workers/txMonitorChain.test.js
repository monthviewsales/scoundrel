'use strict';

jest.mock('../../../lib/wallets/getWalletPrivateKey', () => jest.fn(async () => 'mock-secret'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const workerPath = path.join(__dirname, '..', '..', '..', 'lib', 'warchest', 'workers', 'swapWorker.js');
const mockExecutor = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockSwapExecutor.js');
const monitorWorker = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockTxMonitorWorker.js');

// eslint-disable-next-line global-require
const { forkWorkerWithPayload } = require('../../../lib/warchest/workers/harness');

function makeSecretKey() {
  const kp = Keypair.generate();
  return { secret: bs58.encode(kp.secretKey), pubkey: kp.publicKey.toBase58() };
}

describe('swap worker spawns tx monitor', () => {
  test('propagates swap context into monitor worker IPC', async () => {
    const { secret } = makeSecretKey();
    const logPath = path.join(os.tmpdir(), `tx-monitor-log-${Date.now()}.json`);

    const { result } = await forkWorkerWithPayload(workerPath, {
      payload: {
        side: 'buy',
        mint: 'So11111111111111111111111111111111111111112',
        amount: 1,
        walletPrivateKey: secret,
        slippagePercent: 1,
      },
      env: {
        SWAP_WORKER_EXECUTOR: mockExecutor,
        TX_MONITOR_WORKER_PATH: monitorWorker,
        TX_MONITOR_TEST_LOG: logPath,
      },
      timeoutMs: 5000,
    });

    expect(result.txid).toBe('stub-txid');
    for (let i = 0; i < 10 && !fs.existsSync(logPath); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.existsSync(logPath)).toBe(true);
    const monitorPayload = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(monitorPayload.txid).toBe('stub-txid');
    expect(monitorPayload.mint).toBe('So11111111111111111111111111111111111111112');
    expect(monitorPayload.side).toBe('buy');
  });
});
