
'use strict';

jest.mock('../../../lib/wallets/getWalletPrivateKey', () => jest.fn(async () => 'mock-secret'));

const path = require('path');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

const workerPath = path.join(__dirname, '..', '..', '..', 'lib', 'warchest', 'workers', 'swapWorker.js');
const mockExecutor = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockSwapExecutor.js');
process.env.SWAP_WORKER_EXECUTOR = mockExecutor;

// eslint-disable-next-line global-require
const { forkWorkerWithPayload } = require('../../../lib/warchest/workers/harness');
// eslint-disable-next-line global-require
const { validateSwapPayload } = require('../../../lib/swap/validateSwapPayload');

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
      dryRun: true,
    });

    expect(payload.amount).toBe('50%');
    expect(payload.dryRun).toBe(true);
  });
});

describe('swap worker IPC forwarding', () => {
  test('forwards swap results from the executor', async () => {
    const { secret, pubkey } = makeSecretKey();
    const swapConfigOverride = {
      rpcUrl: 'https://rpc.example.invalid',
      slippage: 12,
      priorityFee: 'auto',
      priorityFeeLevel: 'low',
      txVersion: 'v0',
      showQuoteDetails: false,
      useJito: false,
      jitoTip: 0.0001,
      swapApiKey: 'stub',
      DEBUG_MODE: false,
    };

    const { result } = await forkWorkerWithPayload(workerPath, {
      payload: {
        side: 'buy',
        mint: 'So11111111111111111111111111111111111111112',
        amount: 1,
        walletPrivateKey: secret,
      },
      env: {
        SWAP_WORKER_EXECUTOR: mockExecutor,
        SWAP_CONFIG_JSON: JSON.stringify(swapConfigOverride),
      },
      timeoutMs: 5000,
    });

    expect(result.txid).toBe('stub-txid');
    expect(result.signature).toBe('stub-sig');
    expect(result.slot).toBe(12345);
    expect(result.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.monitorPayload).toBeTruthy();
    expect(result.monitorPayload.txid).toBe('stub-txid');
    expect(result.walletPubkey).toBe(pubkey);
    expect(result.monitorPayload.side).toBe('buy');
    expect(result.monitorPayload.slippagePercent).toBe(12);
  });
});
