'use strict';

const path = require('path');

// --- Mocks ---

// Shared mocks for the SolanaTracker Data client methods
const mockGetWalletTrades = jest.fn();
const mockGetWalletChart = jest.fn();
const mockGetUserTokenTrades = jest.fn();
const mockClose = jest.fn();

// Mock the SolanaTracker data client factory
jest.mock('../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({
    getWalletTrades: mockGetWalletTrades,
    getWalletChart: mockGetWalletChart,
    getUserTokenTrades: mockGetUserTokenTrades,
    close: mockClose,
  })),
}));

// Mock artifact helpers so we don't actually write files
const mockWriteJsonArtifact = jest.fn(() => path.join('/tmp/dossier', 'dummy.json'));

jest.mock('../lib/persist/jsonArtifacts', () => ({
  ...jest.requireActual('../lib/persist/jsonArtifacts'),
  // Under the new writer model, CLI code calls artifacts.write(stage, prefix, data).
  // We keep using a single mockWriteJsonArtifact to assert the write intent.
  createArtifactWriter: jest.fn(({ runId }) => ({
    baseDir: '/tmp/dossier',
    runId: runId || 'test-run-id',
    write: (stage, prefix, data) =>
      mockWriteJsonArtifact(
        '/tmp/dossier',
        [stage],
        `${prefix}-${runId || 'test-run-id'}.json`,
        data,
      ),
  })),
  writeJsonArtifact: mockWriteJsonArtifact,
}));

// Mock technique outcomes builder so that dossier can derive coins / features
const mockBuildTechniqueFeaturesFromMintMap = jest.fn(() => ({
  coins: [
    {
      mint: 'GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump',
      maxGainPct: 50,
      maxLossPct: -20,
      hasBag: false,
      isStoryCoin: false,
    },
  ],
}));

jest.mock('../lib/analysis/techniqueOutcomes', () => ({
  buildFromMintMap: (...args) => mockBuildTechniqueFeaturesFromMintMap(...args),
}));

// Mock BootyBox so dossier does not try to initialize a real DB connection
jest.mock('../db', () => ({
  init: jest.fn(),
  recordWalletDossier: jest.fn(),
  recordDossierRun: jest.fn(),
  recordCoinMetrics: jest.fn(),
}));

// Silence console noise in tests but keep ability to assert on calls if needed
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenAiModel = process.env.OPENAI_RESPONSES_MODEL;

beforeAll(() => {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();

  process.env.OPENAI_API_KEY = originalOpenAiKey || 'test-openai-key';
  process.env.OPENAI_RESPONSES_MODEL = originalOpenAiModel || 'gpt-5-mini';
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;

  process.env.OPENAI_API_KEY = originalOpenAiKey;
  process.env.OPENAI_RESPONSES_MODEL = originalOpenAiModel;
});

describe('harvestWallet (dossier)', () => {
  const WALLET = 'DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR';
  const TRADER_NAME = 'TestTrader';
  const MINT = 'GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump';

  // Simple trade sample: SOL -> token mint (not a stable)
  const sampleTrades = [
    {
      from: { address: 'So11111111111111111111111111111111111111112' }, // SOL
      to: { address: MINT },
      side: 'buy',
      amount: 1,
      price: { sol: 1 },
      timestamp: 10,
    },
    {
      from: { address: MINT },
      to: { address: 'So11111111111111111111111111111111111111112' },
      side: 'sell',
      amount: 1,
      price: { sol: 2 },
      timestamp: 20,
    },
  ];

  const sampleChart = [
    { t: 1, pnlPercentage: -10 },
    { t: 2, pnlPercentage: 0 },
    { t: 3, pnlPercentage: 30 },
  ];

  const sampleMintTrades = [
    {
      txId: 'fake-tx-1',
      mint: MINT,
      side: 'buy',
      amount: 1,
      price: { sol: 1 },
      timestamp: 10,
    },
    {
      txId: 'fake-tx-2',
      mint: MINT,
      side: 'sell',
      amount: 1,
      price: { sol: 2 },
      timestamp: 20,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetWalletTrades.mockResolvedValue(sampleTrades);
    mockGetWalletChart.mockResolvedValue(sampleChart);
    mockGetUserTokenTrades.mockResolvedValue(sampleMintTrades);
    mockClose.mockResolvedValue(undefined);
    mockBuildTechniqueFeaturesFromMintMap.mockClear();
  });

  it('builds a merged payload and skips analysis when runAnalysis=false', async () => {
    const { harvestWallet } = require('../lib/cli/dossier');

    const result = await harvestWallet({
      wallet: WALLET,
      traderName: TRADER_NAME,
      runAnalysis: false,
      featureMintCount: 4,
    });

    expect(result).toBeDefined();
    expect(result.wallet).toBe(WALLET);
    expect(result.traderName).toBe(TRADER_NAME);
    expect(result.count).toBe(sampleTrades.length);
    expect(result.errors).toBe(0);

    // Ensure merged payload exists
    expect(result.merged).toBeDefined();
    expect(result.merged.meta.wallet).toBe(WALLET);
    expect(result.merged.walletChart).toEqual(sampleChart);

    // We expect the mint derivation logic to pick up our single mint
    expect(result.techniqueFeatures).toBeDefined();
    expect(result.techniqueFeatures.coins[0].mint).toBe(MINT);

    // Technique features should be built from the mint map
    expect(mockBuildTechniqueFeaturesFromMintMap).toHaveBeenCalledTimes(1);
    const [mintMapArg] = mockBuildTechniqueFeaturesFromMintMap.mock.calls[0];
    expect(Object.keys(mintMapArg)).toContain(MINT);

    // Coins slice comes from the mocked technique features
    expect(result.merged.techniqueFeatures).toBeDefined();
    expect(result.merged.techniqueFeatures.coins[0].mint).toBe(MINT);

    // Data client was used correctly
    expect(mockGetWalletTrades).toHaveBeenCalledWith({ wallet: WALLET, startTime: undefined, endTime: undefined, limit: expect.any(Number) });
    expect(mockGetWalletChart).toHaveBeenCalledWith(WALLET);
    expect(mockGetUserTokenTrades).toHaveBeenCalledWith(MINT, WALLET);
    expect(mockClose).toHaveBeenCalledTimes(1);

    // Under the new artifact model, dossier writes the prompt payload (merged input) to the prompt stage
    expect(mockWriteJsonArtifact).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/dossier'),
      ['prompt'],
      expect.stringMatching(/^prompt-/),
      expect.any(Object),
    );
  });

  it('returns zero-count result when no trades are found', async () => {
    const { harvestWallet } = require('../lib/cli/dossier');

    mockGetWalletTrades.mockResolvedValue([]);

    const result = await harvestWallet({
      wallet: WALLET,
      traderName: TRADER_NAME,
      runAnalysis: false,
    });

    expect(result.count).toBe(0);
    expect(result.merged).toBeUndefined();
    expect(mockGetWalletTrades).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
