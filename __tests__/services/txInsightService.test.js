'use strict';

jest.mock('../../lib/solanaTrackerRPCClient', () => ({
  createSolanaTrackerRPCClient: jest.fn(() => ({ rpc: {}, rpcSubs: {} })),
}));

const mockRpcMethods = {
  getTransaction: jest.fn(),
  getTokenAccountsByOwnerV2: jest.fn(),
  getSignaturesForAddress: jest.fn(),
};

jest.mock('../../lib/solana/rpcMethods', () => ({
  createRpcMethods: jest.fn(() => mockRpcMethods),
}));

const mockWalletRegistry = {
  getAllWallets: jest.fn(),
};

jest.mock('../../lib/wallets/walletRegistry', () => mockWalletRegistry);

const { STABLE_MINT_LIST } = require('../../lib/solana/stableMints');
const {
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
  recoverSwapInsightFromTransaction,
} = require('../../lib/services/txInsightService');

describe('txInsightService stable mint handling', () => {
  beforeEach(() => {
    mockRpcMethods.getTransaction.mockReset();
    mockRpcMethods.getTokenAccountsByOwnerV2.mockReset();
    mockRpcMethods.getSignaturesForAddress.mockReset();
    mockWalletRegistry.getAllWallets.mockReset();
  });

  test('returns 0 for stablecoin entry price without calling data API', async () => {
    const mint = STABLE_MINT_LIST[0];
    const result = await recoverEntryPriceFromHistory(mint, 'wallet123');

    expect(result).toBe(0);
    expect(mockRpcMethods.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  test('returns 0 for SOL sell price without calling data API', async () => {
    const solMint = 'So11111111111111111111111111111111111111112';
    const result = await recoverSellPriceFromHistory(solMint, 'wallet123');

    expect(result).toBe(0);
    expect(mockRpcMethods.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  test('recovers entry price from stable-quoted swaps using RPC history', async () => {
    const mint = 'MintAAA';
    const walletPubkey = 'DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR';
    const stableMint = STABLE_MINT_LIST[0];

    mockWalletRegistry.getAllWallets.mockResolvedValue([]);

    mockRpcMethods.getTokenAccountsByOwnerV2.mockResolvedValue({
      accounts: [{ pubkey: 'TokenAcct1' }],
    });

    mockRpcMethods.getSignaturesForAddress.mockImplementation((address) => {
      if (address === walletPubkey) {
        return Promise.resolve({
          signatures: [{ signature: 'sig1', blockTime: 100, slot: 5 }],
        });
      }
      if (address === 'TokenAcct1') {
        return Promise.resolve({ signatures: [] });
      }
      return Promise.resolve({ signatures: [] });
    });

    mockRpcMethods.getTransaction.mockResolvedValue({
      blockTime: 1734832800,
      transaction: {
        message: {
          accountKeys: [walletPubkey],
        },
      },
      meta: {
        fee: 5000,
        preBalances: [1000000],
        postBalances: [1000000],
        preTokenBalances: [
          {
            mint,
            owner: walletPubkey,
            uiTokenAmount: { uiAmount: 1, decimals: 6 },
          },
          {
            mint: stableMint,
            owner: walletPubkey,
            uiTokenAmount: { uiAmount: 100, decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            mint,
            owner: walletPubkey,
            uiTokenAmount: { uiAmount: 3, decimals: 6 },
          },
          {
            mint: stableMint,
            owner: walletPubkey,
            uiTokenAmount: { uiAmount: 50, decimals: 6 },
          },
        ],
      },
    });

    const result = await recoverEntryPriceFromHistory(mint, walletPubkey);
    expect(result).toBe(25);
  });

  test('treats SOL-only delta with no token balances as transfer', async () => {
    const txid = '3xuXhGwwnzoPuzPE1W4qhCghfTZsDFuSTiXwtSRrfgUXS2KdLLtgxcMRCB5PSMkZidL13J6wMMWAq3Vfbf5mZE2t';
    const walletAddress = 'DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR';

    mockWalletRegistry.getAllWallets.mockResolvedValue([]);

    mockRpcMethods.getTransaction.mockResolvedValue({
      blockTime: 1734832800,
      transaction: {
        message: {
          accountKeys: [walletAddress],
        },
      },
      meta: {
        fee: 5000,
        preBalances: [1000000],
        postBalances: [994983],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    });

    const insight = await recoverSwapInsightFromTransaction(txid, null, { walletAddress });

    expect(insight).toBeTruthy();
    expect(insight.kind).toBe('transfer');
    expect(insight.mint).toBe('So11111111111111111111111111111111111111112');
    expect(insight.solDeltaNet).toBeLessThan(0);
    expect(insight.tokenDeltaNet).toBe(0);
  });
});
