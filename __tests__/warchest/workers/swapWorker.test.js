
'use strict';

jest.mock('../../../lib/wallets/getWalletPrivateKey', () => jest.fn(async () => 'mock-secret'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

const workerPath = path.join(__dirname, '..', '..', '..', 'lib', 'warchest', 'workers', 'swapWorker.js');
const mockExecutor = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockSwapExecutor.js');
const monitorWorker = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockTxMonitorWorker.js');

process.env.SWAP_WORKER_EXECUTOR = mockExecutor;

// eslint-disable-next-line global-require
const { forkWorkerWithPayload } = require('../../../lib/warchest/workers/harness');
// eslint-disable-next-line global-require
const { validateSwapPayload } = require('../../../lib/warchest/workers/swapWorker');

function makeSecretKey() {
  const kp = Keypair.generate();
  return { secret: bs58.encode(kp.secretKey), pubkey: kp.publicKey.toBase58() };
}

describe('swap worker payload validation', () => {
  test('rejects invalid sides and amounts', () => {
    expect(() => validateSwapPayload({ side: 'hold' })).toThrow(/side/);
    expect(() => validateSwapPayload({ side: 'buy', mint: 'x', amount: 0, walletAlias: 'a' })).toThrow(/Invalid mint/);
    expect(() => validateSwapPayload({ side: 'buy', mint: 'So11111111111111111111111111111111111111112', amount: 'auto', walletAlias: 'a' })).toThrow(/only valid for sells/);
  });

  test('accepts normalized payloads', () => {
    const payload = validateSwapPayload({
      side: 'sell',
      mint: 'So11111111111111111111111111111111111111112',
      amount: '50%',
      walletAlias: 'main',
      slippagePercent: 5,
      priorityFee: 'auto',
      useJito: true,
      priorityFeeLevel: 'medium',
      txVersion: 'legacy',
      showQuoteDetails: 'true',
      debugLogging: 1,
      dryRun: true,
    });

    expect(payload.amount).toBe('50%');
    expect(payload.slippagePercent).toBe(5);
    expect(payload.priorityFee).toBe('auto');
    expect(payload.priorityFeeLevel).toBe('medium');
    expect(payload.txVersion).toBe('legacy');
    expect(payload.useJito).toBe(true);
    expect(payload.showQuoteDetails).toBe(true);
    expect(payload.debugLogging).toBe(true);
    expect(payload.dryRun).toBe(true);
  });
});

describe('swap worker IPC forwarding', () => {
  test('forwards swap results from the executor', async () => {
    const { secret, pubkey } = makeSecretKey();
    const logPath = path.join(os.tmpdir(), `swap-worker-log-${Date.now()}.json`);

    const { result } = await forkWorkerWithPayload(workerPath, {
      payload: {
        side: 'buy',
        mint: 'So11111111111111111111111111111111111111112',
        amount: 1,
        walletPrivateKey: secret,
        slippagePercent: 12,
      },
      env: {
        SWAP_WORKER_EXECUTOR: mockExecutor,
        SWAP_WORKER_TEST_LOG: logPath,
        TX_MONITOR_WORKER_PATH: monitorWorker,
      },
      timeoutMs: 5000,
    });

    expect(result.txid).toBe('stub-txid');
    expect(result.signature).toBe('stub-sig');
    expect(result.slot).toBe(12345);
    expect(result.timing.durationMs).toBeGreaterThanOrEqual(0);
    const logged = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(logged.walletPubkey).toBe(pubkey);
    expect(logged.side).toBe('buy');
    expect(logged.slippagePercent).toBe(12);
  });
});
