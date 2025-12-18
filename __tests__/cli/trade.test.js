'use strict';

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../../lib/warchest/workers/harness', () => ({
  forkWorkerWithPayload: jest.fn(() => Promise.resolve({ result: { txid: 'worker-txid' } })),
  buildWorkerEnv: jest.fn(() => ({})),
}));

jest.mock('../../lib/wallets/resolver', () => {
  // Deterministic “fake” keypair for tests (NOT a real secret)
  let secretKeyBytes;
  try {
    // If you still have web3.js in deps/devDeps
    const { Keypair } = require('@solana/web3.js');
    const kp = Keypair.fromSeed(Buffer.alloc(32, 7)); // stable across runs
    secretKeyBytes = kp.secretKey; // Uint8Array(64)
  } catch (e) {
    // Fallback: shape-only (won’t work if actual signing happens)
    secretKeyBytes = Uint8Array.from(Buffer.alloc(64, 7));
  }

  const secretKeyArray = Array.from(secretKeyBytes);

  const resolveAliasOrAddress = jest.fn(async (input) => ({
    wallet: {
      id: 1,
      alias: String(input),
      address: 'So11111111111111111111111111111111111111112',
      walletId: 1,
      wallet_id: 1,
      pubkey: 'So11111111111111111111111111111111111111112',

      // Provide signer material in a few common shapes so whichever path you hit works
      secretKey: secretKeyArray,
      secret_key: secretKeyArray,
      privateKey: secretKeyArray,
      private_key: secretKeyArray,
      has_private_key: true,
      hasPrivateKey: true,
    },
  }));

  return {
    createWalletResolver: jest.fn(() => ({ resolveAliasOrAddress })),
    resolveAliasOrAddress,
  };
});

const logger = require('../../lib/logger');
const { forkWorkerWithPayload } = require('../../lib/warchest/workers/harness');
const tradeCli = require('../../lib/cli/trade');

function setStdoutTty(stdoutIsTty) {
  const prev = {
    stdout: process.stdout.isTTY,
  };

  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdoutIsTty,
    configurable: true,
  });

  return () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: prev.stdout,
      configurable: true,
    });
  };
}

describe('trade CLI (worker-based)', () => {
  beforeEach(() => {
    forkWorkerWithPayload.mockClear();
    logger.info.mockClear();
    logger.debug.mockClear();
    logger.warn.mockClear();
  });

  test('propagates txid from swap worker', async () => {
    const restoreTty = setStdoutTty(false);
    try {
      await tradeCli('So11111111111111111111111111111111111111112', {
        wallet: 'alias',
        buy: 1,
      });
    } finally {
      restoreTty();
    }

    expect(forkWorkerWithPayload).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('txid: worker-txid'));
  });

  test('passes detach flag through to swap worker payload', async () => {
    const restoreTty = setStdoutTty(false);
    try {
      await tradeCli('So11111111111111111111111111111111111111112', {
        wallet: 'alias',
        buy: 1,
        detach: true,
      });
    } finally {
      restoreTty();
    }

    const call = forkWorkerWithPayload.mock.calls[0] || [];
    const options = call[1] || {};
    expect(options.payload).toEqual(expect.objectContaining({ detachMonitor: true }));
  });
});
