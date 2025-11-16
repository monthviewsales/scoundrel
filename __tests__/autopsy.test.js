'use strict';

const path = require('path');

const mockRunData = {
  walletLabel: 'warlord',
  walletAddress: 'Wallet111',
  mint: 'Mint111',
};

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock('../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({
    getTokenInformation: jest.fn().mockResolvedValue({ symbol: 'TEST', name: 'Token', decimals: 9 }),
    getWalletTrades: jest.fn().mockResolvedValue([
      { mint: 'Mint111', side: 'buy', amount: 2, price: { sol: 1 }, timestamp: 10 },
      { mint: 'Mint111', side: 'sell', amount: 1, price: { sol: 2 }, timestamp: 20 },
    ]),
    getPriceRange: jest.fn().mockResolvedValue({ low: 1, high: 2 }),
    getTokenPnL: jest.fn().mockResolvedValue({ pnl: 1 }),
    getAthPrice: jest.fn().mockResolvedValue({ ath: 3 }),
    getTokenOhlcvData: jest.fn().mockResolvedValue({ candles: [{ t: 5, o: 1, h: 2, l: 1, c: 2, v: 10 }] }),
  })),
}));

jest.mock('../ai/jobs/tradeAutopsy', () => ({
  analyzeTradeAutopsy: jest.fn().mockResolvedValue({ grade: 'B', summary: 'ok', entryAnalysis: 'e', exitAnalysis: 'x', riskManagement: 'r', profitability: 'p', lessons: [], tags: [] }),
}));

jest.mock('../lib/db/mysql', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock('../lib/id/issuer', () => ({
  requestId: jest.fn().mockResolvedValue('autopsyid1234567890123456'),
}));

describe('runAutopsy', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('builds payload, calls AI, and writes artifact', async () => {
    const fs = require('fs');
    const { runAutopsy } = require('../lib/autopsy');

    const result = await runAutopsy(mockRunData);

    expect(result.ai.grade).toBe('B');
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(path.basename(result.artifactPath)).toMatch(/^autopsy-/);
  });
});
