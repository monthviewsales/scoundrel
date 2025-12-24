'use strict';

const mockDataClient = {
  getUserTokenTrades: jest.fn(),
};

jest.mock('../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => mockDataClient),
}));

jest.mock('../../lib/solanaTrackerRPCClient', () => ({
  createSolanaTrackerRPCClient: jest.fn(() => ({ rpc: {}, rpcSubs: {} })),
}));

const mockRpcMethods = {
  getTransaction: jest.fn(),
};

jest.mock('../../lib/solana/rpcMethods', () => ({
  createRpcMethods: jest.fn(() => mockRpcMethods),
}));

const { STABLE_MINT_LIST } = require('../../lib/solana/stableMints');
const {
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
  recoverSwapInsightFromTransaction,
} = require('../../lib/services/txInsightService');

describe('txInsightService stable mint handling', () => {
  beforeEach(() => {
    mockDataClient.getUserTokenTrades.mockReset();
    mockRpcMethods.getTransaction.mockReset();
  });

  test('returns 0 for stablecoin entry price without calling data API', async () => {
    const mint = STABLE_MINT_LIST[0];
    const result = await recoverEntryPriceFromHistory(mint, 'wallet123');

    expect(result).toBe(0);
    expect(mockDataClient.getUserTokenTrades).not.toHaveBeenCalled();
  });

  test('returns 0 for SOL sell price without calling data API', async () => {
    const solMint = 'So11111111111111111111111111111111111111112';
    const result = await recoverSellPriceFromHistory(solMint, 'wallet123');

    expect(result).toBe(0);
    expect(mockDataClient.getUserTokenTrades).not.toHaveBeenCalled();
  });

  test('treats SOL-only delta with no token balances as transfer', async () => {
    const txid = '3xuXhGwwnzoPuzPE1W4qhCghfTZsDFuSTiXwtSRrfgUXS2KdLLtgxcMRCB5PSMkZidL13J6wMMWAq3Vfbf5mZE2t';
    const walletAddress = 'DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR';

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
