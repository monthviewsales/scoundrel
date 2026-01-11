'use strict';

jest.mock('solana-swap', () => ({
  SolanaTracker: jest.fn(),
}));

jest.mock('bs58', () => ({
  decode: jest.fn(() => new Uint8Array([1, 2, 3])),
}));

jest.mock('@solana/web3.js', () => ({
  Keypair: {
    fromSecretKey: jest.fn(),
  },
}));

jest.mock('../../lib/swap/swapConfig', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('../../lib/wallets/getWalletPrivateKey', () => jest.fn());

jest.mock('../../lib/solana/stableMints', () => ({
  isStableMint: jest.fn(() => false),
}));

const { SolanaTracker } = require('solana-swap');
const { Keypair } = require('@solana/web3.js');
const { loadConfig } = require('../../lib/swap/swapConfig');
const getWalletPrivateKey = require('../../lib/wallets/getWalletPrivateKey');

describe('swapHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('buyToken throws when private key is missing', async () => {
    loadConfig.mockResolvedValue({ rpcUrl: 'https://rpc.example' });
    getWalletPrivateKey.mockResolvedValue(null);

    const { buyToken } = require('../../lib/swap/swapHelper');

    await expect(buyToken({
      walletAlias: 'alpha',
      mint: 'Mint111',
      amount: 1,
    })).rejects.toThrow('Private key not found for wallet alias "alpha"');
  });

  test('buyToken returns swap summary and totals', async () => {
    loadConfig.mockResolvedValue({
      rpcUrl: 'https://rpc.example',
      swapApiKey: 'api-key',
      DEBUG_MODE: true,
      slippage: 5,
      priorityFeeLevel: 'low',
      txVersion: 'v0',
    });
    getWalletPrivateKey.mockResolvedValue('[1,2,3,4]');
    Keypair.fromSecretKey.mockReturnValue({
      publicKey: { toBase58: () => 'PUBKEY' },
    });

    const tracker = {
      keypair: { publicKey: { toBase58: () => 'PUBKEY' } },
      getSwapInstructions: jest.fn().mockResolvedValue({
        quote: {
          amountOut: 10,
          fee: 0.2,
          platformFeeUI: 0.01,
          priceImpact: 0.5,
        },
      }),
      performSwap: jest.fn().mockResolvedValue({ signature: 'sig-123' }),
      setDebug: jest.fn(),
    };

    SolanaTracker.mockImplementation(() => tracker);

    const { buyToken } = require('../../lib/swap/swapHelper');
    const result = await buyToken({
      walletAlias: 'beta',
      mint: 'Mint111',
      amount: 1.5,
    });

    expect(SolanaTracker).toHaveBeenCalledWith(
      expect.any(Object),
      'https://rpc.example?advancedTx=true',
      'api-key',
      true,
    );
    expect(tracker.getSwapInstructions).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      txid: 'sig-123',
      tokensReceivedDecimal: 10,
      priceImpact: 0.5,
    }));
    expect(result.totalFees).toBeCloseTo(0.21, 6);
  });

  test('sellToken returns sol received totals', async () => {
    loadConfig.mockResolvedValue({
      rpcUrl: 'https://rpc.example?foo=bar',
      swapApiKey: 'api-key',
      DEBUG_MODE: false,
      slippage: 5,
      priorityFeeLevel: 'low',
      txVersion: 'v0',
    });
    getWalletPrivateKey.mockResolvedValue('[1,2,3,4]');
    Keypair.fromSecretKey.mockReturnValue({
      publicKey: { toBase58: () => 'PUBKEY' },
    });

    const tracker = {
      keypair: { publicKey: { toBase58: () => 'PUBKEY' } },
      getSwapInstructions: jest.fn().mockResolvedValue({
        quote: {
          outAmount: 0.5,
          fee: 0.1,
          platformFeeUI: 0.0,
          priceImpact: 0.2,
        },
      }),
      performSwap: jest.fn().mockResolvedValue('sig-456'),
    };

    SolanaTracker.mockImplementation(() => tracker);

    const { sellToken } = require('../../lib/swap/swapHelper');
    const result = await sellToken({
      walletAlias: 'gamma',
      mint: 'Mint111',
      amount: 2,
    });

    expect(result).toEqual(expect.objectContaining({
      txid: 'sig-456',
      solReceivedDecimal: 0.5,
      totalFees: 0.1,
      priceImpact: 0.2,
    }));
  });
});
