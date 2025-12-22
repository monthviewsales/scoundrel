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

jest.mock('../../lib/solana/rpcMethods', () => ({
  createRpcMethods: jest.fn(() => ({})),
}));

const { STABLE_MINT_LIST } = require('../../lib/solana/stableMints');
const {
  recoverEntryPriceFromHistory,
  recoverSellPriceFromHistory,
} = require('../../lib/services/txInsightService');

describe('txInsightService stable mint handling', () => {
  beforeEach(() => {
    mockDataClient.getUserTokenTrades.mockReset();
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
});
