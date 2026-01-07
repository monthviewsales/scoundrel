'use strict';

jest.mock('../../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../../lib/persist/jsonArtifacts', () => ({
  createArtifactWriter: jest.fn(() => ({
    runId: 'run-123',
    write: jest.fn(() => '/tmp/artifact.json'),
  })),
}));

jest.mock('../../../lib/services/tokenInfoService', () => ({
  ensureTokenInfo: jest.fn(async ({ mint }) => ({
    token: { mint, symbol: 'SYM', name: 'Sample' },
  })),
}));

jest.mock('../../../lib/warchest/events', () => ({
  appendHubEvent: jest.fn(),
}));

jest.mock('../../../db', () => ({
  init: jest.fn(async () => {}),
  addUpdateTarget: jest.fn(),
}));

const {
  parseIntervalMs,
  validateTargetListPayload,
  runTargetListOnce,
} = require('../../../lib/warchest/workers/targetListWorker');

describe('targetListWorker', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  test('parseIntervalMs handles OFF and numeric values', () => {
    expect(parseIntervalMs('OFF', 123)).toBeNull();
    expect(parseIntervalMs('60000', 123)).toBe(60000);
    expect(parseIntervalMs('no', 123)).toBeNull();
    expect(parseIntervalMs('bad', 456)).toBe(456);
  });

  test('validateTargetListPayload reads env and allows overrides', () => {
    process.env.WARCHEST_TARGET_LIST_INTERVAL_MS = '120000';
    const defaults = validateTargetListPayload({});
    expect(defaults.intervalMs).toBe(120000);
    expect(defaults.runOnce).toBe(true);

    const overridden = validateTargetListPayload({ intervalMs: '300000', runOnce: false });
    expect(overridden.intervalMs).toBe(300000);
    expect(overridden.runOnce).toBe(false);
  });

  test('runTargetListOnce fetches volume/trending and returns counts', async () => {
    const dataClient = {
      getTokensByVolumeWithTimeframe: jest.fn(async () => [{ mint: 'a' }, { mint: 'b' }]),
      getTrendingTokens: jest.fn(async () => [{ mint: 'x' }]),
    };

    const result = await runTargetListOnce({ dataClient });

    expect(dataClient.getTokensByVolumeWithTimeframe).toHaveBeenCalledWith({ timeframe: '30m' });
    expect(dataClient.getTrendingTokens).toHaveBeenCalledWith({ timeframe: '1h' });
    expect(result.runId).toBe('run-123');
    expect(result.counts).toEqual({ volume: 2, trending: 1 });
    expect(result.artifacts.volumePath).toBe('/tmp/artifact.json');
    expect(result.artifacts.trendingPath).toBe('/tmp/artifact.json');
    expect(result.summary.uniqueMints).toBe(3);
  });
});
