'use strict';

const path = require('path');

const mockExecutor = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockSwapExecutor.js');
process.env.SWAP_WORKER_EXECUTOR = mockExecutor;

jest.mock('../../../lib/swap/validateSwapPayload', () => ({
  validateSwapPayload: jest.fn(),
}));

jest.mock('../../../lib/swap/swapConfig', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('@solana/kit', () => ({
  createKeyPairFromBytes: jest.fn(),
  createSignerFromKeyPair: jest.fn(),
}));

jest.mock('@solana/keys', () => ({
  createKeyPairFromPrivateKeyBytes: jest.fn(),
}));

jest.mock('bs58', () => ({
  decode: jest.fn(() => new Uint8Array(64)),
}));

const { validateSwapPayload } = require('../../../lib/swap/validateSwapPayload');
const { loadConfig } = require('../../../lib/swap/swapConfig');
const { createKeyPairFromBytes, createSignerFromKeyPair } = require('@solana/kit');

const { executeSwap } = require('../../../lib/warchest/workers/swapWorker');

describe('swapWorker executeSwap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns executor results with monitor payload', async () => {
    validateSwapPayload.mockReturnValue({
      side: 'buy',
      mint: 'MintA',
      amount: 1,
      walletPrivateKey: JSON.stringify(Array(64).fill(1)),
    });
    loadConfig.mockResolvedValue({
      slippage: 10,
      priorityFeeLevel: 'low',
      txVersion: 'v0',
      showQuoteDetails: false,
      DEBUG_MODE: false,
      useJito: false,
      jitoTip: 0,
    });
    createKeyPairFromBytes.mockReturnValue({ keypair: true });
    createSignerFromKeyPair.mockResolvedValue({ address: 'WalletPubkey' });

    const result = await executeSwap({ side: 'buy', mint: 'MintA', amount: 1 });

    expect(result.txid).toBe('stub-txid');
    expect(result.signature).toBe('stub-sig');
    expect(result.monitorPayload.txid).toBe('stub-txid');
    expect(result.monitorPayload.side).toBe('buy');
  });

  test('throws when wallet pubkey does not match', async () => {
    validateSwapPayload.mockReturnValue({
      side: 'buy',
      mint: 'MintA',
      amount: 1,
      walletPrivateKey: JSON.stringify(Array(64).fill(1)),
      walletPubkey: 'ExpectedPubkey',
    });
    loadConfig.mockResolvedValue({ slippage: 10 });
    createKeyPairFromBytes.mockReturnValue({ keypair: true });
    createSignerFromKeyPair.mockResolvedValue({ address: 'DifferentPubkey' });

    await expect(executeSwap({ side: 'buy', mint: 'MintA', amount: 1 }))
      .rejects
      .toThrow('Resolved wallet pubkey (ExpectedPubkey) does not match private key pubkey (DifferentPubkey).');
  });
});
