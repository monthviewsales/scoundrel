'use strict';

const path = require('path');

const mockRunData = {
  walletLabel: 'warlord',
  walletAddress: 'DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR',
  mint: 'GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump',
};

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock('../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({
    getTokenInformation: jest.fn().mockResolvedValue({
      symbol: 'CHILLHOUSE',
      name: 'Chillhouse',
      decimals: 9,
    }),
    getWalletTrades: jest.fn().mockResolvedValue([
      {
        mint: 'GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump',
        side: 'buy',
        amount: 2,
        price: { sol: 1 },
        timestamp: 10,
      },
      {
        mint: 'GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump',
        side: 'sell',
        amount: 1,
        price: { sol: 2 },
        timestamp: 20,
      },
    ]),
    getUserTokenTrades: jest.fn().mockResolvedValue([
      {
        txId: 'fake-tx-id-1',
        mint: mockRunData.mint,
        side: 'buy',
        amount: 2,
        price: { sol: 1 },
        timestamp: 10,
      },
      {
        txId: 'fake-tx-id-2',
        mint: mockRunData.mint,
        side: 'sell',
        amount: 1,
        price: { sol: 2 },
        timestamp: 20,
      },
    ]),
    getPriceRange: jest.fn().mockResolvedValue({ low: 1, high: 2 }),
    getTokenPnL: jest.fn().mockResolvedValue({ pnl: 1 }),
    getAthPrice: jest.fn().mockResolvedValue({ ath: 3 }),
    getTokenOhlcvData: jest
      .fn()
      .mockResolvedValue({ candles: [{ t: 5, o: 1, h: 2, l: 1, c: 2, v: 10 }] }),
  })),
}));

jest.mock('../ai/jobs/tradeAutopsy', () => ({
  analyzeTradeAutopsy: jest.fn().mockResolvedValue({ grade: 'B', summary: 'ok', entryAnalysis: 'e', exitAnalysis: 'x', riskManagement: 'r', profitability: 'p', lessons: [], tags: [] }),
}));

jest.mock('../lib/log', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockBootInit = jest.fn().mockResolvedValue();
const mockGetCoin = jest.fn().mockResolvedValue(null);
const mockAddCoin = jest.fn().mockResolvedValue();
const mockUpsertProfile = jest.fn().mockResolvedValue();
const mockRecordAutopsy = jest.fn().mockResolvedValue();

jest.mock('../lib/db/BootyBox.mysql', () => ({
  init: mockBootInit,
  getCoinByMint: mockGetCoin,
  addOrUpdateCoin: mockAddCoin,
  upsertProfileSnapshot: mockUpsertProfile,
  recordTradeAutopsy: mockRecordAutopsy,
}));

jest.mock('../lib/id/issuer', () => ({
  requestId: jest.fn().mockResolvedValue('autopsyid1234567890123456'),
}));

describe('runAutopsy', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetCoin.mockResolvedValue(null);
    mockAddCoin.mockResolvedValue();
  });

  test('builds payload, calls AI, and writes artifact', async () => {
    const fs = require('fs');
    const { runAutopsy } = require('../lib/autopsy');

    const result = await runAutopsy(mockRunData);

    expect(result.ai.grade).toBe('B');
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(path.basename(result.artifactPath)).toMatch(/^autopsy-/);
    expect(mockRecordAutopsy).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: mockRunData.walletAddress,
        mint: mockRunData.mint,
      }),
    );
  });

  test('logs context when coin persistence fails', async () => {
    const fs = require('fs');
    const log = require('../lib/log');
    const err = new Error("Unknown column 'status' in 'field list'");
    err.code = 'ER_BAD_FIELD_ERROR';
    err.errno = 1054;
    err.sqlState = '42S22';
    mockGetCoin.mockResolvedValue(null);
    mockAddCoin.mockRejectedValueOnce(err);

    const { runAutopsy } = require('../lib/autopsy');
    await runAutopsy(mockRunData);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('[tokenInfoService.ensureTokenInfo] failed to persist token info'),
      expect.objectContaining({
        mint: mockRunData.mint,
        code: 'ER_BAD_FIELD_ERROR',
        errno: 1054,
        sqlState: '42S22',
      }),
      expect.stringContaining("Unknown column 'status'"),
    );
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
