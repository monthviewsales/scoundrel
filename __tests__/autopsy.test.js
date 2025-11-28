'use strict';

const path = require('path');

const mockRunData = {
  walletLabel: 'warlord',
  walletAddress: 'DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR',
  mint: '36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump',
};

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock('../lib/solanaTrackerDataClient', () => {
  const path = require('path');
  const fsActual = require('fs'); // use the real fs here, not the jest-mocked one

  const FIXTURE_MINT = '36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump';
  const RAW_BASE = path.join(
    __dirname,
    '__fixtures__',
    'autopsy',
    FIXTURE_MINT,
    'raw'
  );

  const loadRaw = (file) =>
    JSON.parse(fsActual.readFileSync(path.join(RAW_BASE, file), 'utf8'));

  const mockClient = {
    // token metadata for this mint
    getTokenInformation: jest
      .fn()
      .mockResolvedValue(loadRaw('tokenInfo-2025-11-22T16-39-13-928Z.json')),

    // wallet/mint trade history
    getUserTokenTrades: jest
      .fn()
      .mockResolvedValue(loadRaw('userTokenTrades-2025-11-22T16-39-13-928Z.json')),

    // not used heavily in tests; safe to stub or derive later if needed
    getWalletTrades: jest.fn().mockResolvedValue([]),

    // price/time-series data
    getTokenOhlcvData: jest
      .fn()
      .mockResolvedValue(loadRaw('ohlcv-2025-11-22T16-39-13-928Z.json')),

    // other helpers can be light stubs for the test
    getPriceRange: jest.fn().mockResolvedValue(null),
    getTokenPnL: jest.fn().mockResolvedValue(null),
    getAthPrice: jest.fn().mockResolvedValue(null),
  };

  return {
    createSolanaTrackerDataClient: jest.fn(() => mockClient),
  };
});


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

jest.mock('../packages/BootyBox', () => ({
  init: mockBootInit,
  getCoinByMint: mockGetCoin,
  addOrUpdateCoin: mockAddCoin,
  upsertProfileSnapshot: mockUpsertProfile,
  recordTradeAutopsy: mockRecordAutopsy,
}));

jest.mock('../lib/id/issuer', () => ({
  requestId: jest.fn().mockResolvedValue('autopsyid1234567890123456'),
}));

describe('buildAutopsyPayload', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetCoin.mockResolvedValue(null);
    mockAddCoin.mockResolvedValue();
  });

test.skip('blends tokenInfo, trades, and ohlcv into the expected payload', async () => {
    const fs = require('fs');
    const { buildAutopsyPayload } = require('../lib/autopsy');

    // Load the enriched autopsy payload fixture we previously generated.
    const fixturePayload = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          '__fixtures__',
          'autopsy',
          mockRunData.mint,
          'enriched',
          'autopsyPayload-2025-11-22T16-39-13-928Z.json',
        ),
        'utf8',
      ),
    );

    const { payload } = await buildAutopsyPayload({
      walletLabel: mockRunData.walletLabel,
      walletAddress: mockRunData.walletAddress,
      mint: mockRunData.mint,
      // client is provided via the mocked createSolanaTrackerDataClient
      client: require('../lib/solanaTrackerDataClient').createSolanaTrackerDataClient(),
    });

    expect(payload).toEqual(fixturePayload);
  });
});
