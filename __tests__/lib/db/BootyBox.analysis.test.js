'use strict';

const mockQuery = jest.fn().mockResolvedValue([[], []]);
const mockGetConnection = jest.fn().mockResolvedValue({
  query: jest.fn(),
  beginTransaction: jest.fn(),
  commit: jest.fn(),
  rollback: jest.fn(),
  release: jest.fn(),
});
const mockPool = {
  query: mockQuery,
  getConnection: mockGetConnection,
};
const mockGetPool = jest.fn(() => mockPool);
const mockPing = jest.fn().mockResolvedValue();
const mockClose = jest.fn().mockResolvedValue();

jest.mock('../../../lib/db/mysql', () => ({
  getPool: mockGetPool,
  ping: mockPing,
  close: mockClose,
}));

describe('BootyBox analysis persistence', () => {
  let BootyBox;

  const loadBootyBox = async () => {
    jest.resetModules();
    BootyBox = require('../../../lib/packages/bootybox');
    mockQuery.mockResolvedValue([[], []]);
    await BootyBox.init();
    mockQuery.mockClear();
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await loadBootyBox();
  });

  test('recordWalletAnalysis writes JSON with version', async () => {
    mockQuery.mockResolvedValueOnce([{}, undefined]);

    await BootyBox.recordWalletAnalysis({
      analysisId: 'an-1',
      wallet: 'Wallet111',
      traderName: 'Alice',
      tradeCount: 3,
      chartCount: 1,
      merged: { foo: 'bar' },
      responseRaw: { version: 'v1' },
      jsonVersion: 'dossier.v1',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('sc_wallet_analyses'),
      expect.arrayContaining([
        'an-1',
        'Wallet111',
        'Alice',
        3,
        1,
        'dossier.v1',
        JSON.stringify({ foo: 'bar' }),
        JSON.stringify({ version: 'v1' }),
      ])
    );
  });

  test('recordTradeAutopsy persists payload and version', async () => {
    mockQuery.mockResolvedValueOnce([{}, undefined]);

    await BootyBox.recordTradeAutopsy({
      autopsyId: 'au-1',
      wallet: 'Wallet222',
      mint: 'Mint333',
      symbol: 'COIN',
      payload: { campaign: {} },
      responseRaw: { grade: 'A' },
      jsonVersion: 'autopsy.v1',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('sc_trade_autopsies'),
      expect.arrayContaining([
        'au-1',
        'Wallet222',
        'Mint333',
        'COIN',
        'autopsy.v1',
        JSON.stringify({ campaign: {} }),
        JSON.stringify({ grade: 'A' }),
      ])
    );
  });

  test('list helpers respect wallet filter and limit', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ analysis_id: 'an-latest' }], undefined])
      .mockResolvedValueOnce([[{ autopsy_id: 'au-latest' }], undefined]);

    const analyses = await BootyBox.listWalletAnalysesByWallet('WalletABC', { limit: 5 });
    const autopsies = await BootyBox.listTradeAutopsiesByWallet('WalletABC', { limit: 2 });

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM sc_wallet_analyses'),
      ['WalletABC', 5]
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM sc_trade_autopsies'),
      ['WalletABC', 2]
    );
    expect(analyses[0]).toMatchObject({ analysis_id: 'an-latest' });
    expect(autopsies[0]).toMatchObject({ autopsy_id: 'au-latest' });
  });
});

