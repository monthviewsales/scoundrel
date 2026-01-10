'use strict';

const mockAnalyzeDevscan = jest.fn();
const mockCreateCommandRun = jest.fn();
const mockPersistProfileSnapshot = jest.fn();
const mockPersistCoinMetadata = jest.fn();
const mockRequestId = jest.fn();
const mockWriteArtifact = jest.fn();

jest.mock('../../ai/jobs/devscanAnalysis', () => ({
  analyzeDevscan: (...args) => mockAnalyzeDevscan(...args),
}));

jest.mock('../../lib/cli/aiRun', () => ({
  createCommandRun: (...args) => mockCreateCommandRun(...args),
}));

jest.mock('../../lib/persist/aiPersistence', () => ({
  persistProfileSnapshot: (...args) => mockPersistProfileSnapshot(...args),
  persistCoinMetadata: (...args) => mockPersistCoinMetadata(...args),
}));

jest.mock('../../lib/id/issuer', () => ({
  requestId: (...args) => mockRequestId(...args),
}));

jest.mock('../../db', () => ({
  init: jest.fn(),
}));

const originalFetch = global.fetch;
const originalDevscanKey = process.env.DEVSCAN_API_KEY;
const originalXaiKey = process.env.xAI_API_KEY;

beforeAll(() => {
  global.fetch = jest.fn();
  process.env.DEVSCAN_API_KEY = 'test-devscan-key';
  process.env.xAI_API_KEY = 'test-xai-key';
});

afterAll(() => {
  global.fetch = originalFetch;
  process.env.DEVSCAN_API_KEY = originalDevscanKey;
  process.env.xAI_API_KEY = originalXaiKey;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteArtifact.mockImplementation((_stage, prefix) => `/tmp/devscan/${prefix}.json`);
  mockCreateCommandRun.mockReturnValue({
    runId: 'run-1',
    isDev: false,
    artifacts: { write: mockWriteArtifact },
  });
  mockRequestId.mockResolvedValue('devscan-1234567890');
});

function mockFetchJson(payload, ok = true) {
  global.fetch.mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? 'OK' : 'Not Found',
    text: async () => JSON.stringify(payload),
  });
}

test('runDevscan skips analysis for mint-only and persists metadata', async () => {
  const { runDevscan } = require('../../lib/cli/devscan');

  mockFetchJson({ success: true, data: { mintAddress: 'Mint1' } });

  const result = await runDevscan({
    mint: 'Mint1',
  });

  expect(mockCreateCommandRun).toHaveBeenCalledWith(expect.objectContaining({
    command: 'devscan',
    segments: ['mint-Mint1'],
  }));

  expect(mockWriteArtifact).toHaveBeenCalledWith('raw', 'token', expect.any(Object));
  expect(mockWriteArtifact).toHaveBeenCalledWith('prompt', 'Mint1_prompt', expect.any(Object));

  expect(mockAnalyzeDevscan).not.toHaveBeenCalled();
  expect(mockPersistCoinMetadata).toHaveBeenCalledWith(expect.objectContaining({
    mint: 'Mint1',
    source: 'devscan',
  }));
  expect(mockPersistProfileSnapshot).not.toHaveBeenCalled();

  expect(result.payload).toBeDefined();
  expect(result.openAiResult).toBeNull();
});

test('runDevscan runs analysis and persists profile snapshot', async () => {
  const { runDevscan } = require('../../lib/cli/devscan');

  mockFetchJson({ success: true, data: { developer: { wallet: 'Dev2' } } });

  mockAnalyzeDevscan.mockResolvedValue({
    version: 'devscan.mint.v1',
    markdown: '# ok',
    entity_type: 'mint',
    target: 'Mint2',
    mint: {
      address: 'Mint2',
      symbol: null,
      name: null,
      status: null,
      createdAt: null,
      priceUsd: null,
      marketCapUsd: null,
      migrated: null,
      creatorWallet: null,
      launchPlatform: null,
    },
    developer: null,
    x_mentions: {
      query: 'Mint2',
      last_60m: null,
      last_30m: null,
      last_5m: null,
      top_accounts: [],
      notes: 'no data',
    },
    x_profiles: [],
    highlights: [],
    risk_flags: [],
    confidence: 0.5,
  });

  const result = await runDevscan({ developerWallet: 'Dev2' });

  expect(mockAnalyzeDevscan).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.any(Object),
  }));

  expect(mockWriteArtifact).toHaveBeenCalledWith('response', 'Dev2_response', expect.any(Object));
  expect(mockPersistCoinMetadata).not.toHaveBeenCalled();
  expect(mockPersistProfileSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    source: 'devscan',
    name: 'dev:Dev2',
  }));

  expect(result.openAiResult).toBeDefined();
});

test('runDevscan surfaces developer not found cleanly', async () => {
  const { runDevscan } = require('../../lib/cli/devscan');

  mockFetchJson({ success: false, error: { code: 'DEVELOPER_NOT_FOUND', message: 'Developer not found' } }, false);

  await expect(runDevscan({
    developerWallet: 'DevMissing1',
  })).rejects.toThrow('[devscan] developer not found for wallet DevMissing1');
});
