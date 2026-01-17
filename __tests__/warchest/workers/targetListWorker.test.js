'use strict';

const mockBounceTokens = jest.fn((tokens) => tokens.filter((token) => token.keep));
const mockEnsureTokenInfo = jest.fn();
const mockPruneTargets = jest.fn();
const mockCreateArtifactWriter = jest.fn(() => ({
  runId: 'run-1',
  write: jest.fn(() => null),
}));

jest.mock('../../../lib/analysis/tokenBouncer', () => ({
  bounceTokens: (...args) => mockBounceTokens(...args),
}));

jest.mock('../../../lib/services/tokenInfoService', () => ({
  ensureTokenInfo: (...args) => mockEnsureTokenInfo(...args),
}));

jest.mock('../../../lib/services/targetPruning', () => ({
  pruneTargetsWithVectorStoreCleanup: (...args) => mockPruneTargets(...args),
}));

jest.mock('../../../lib/persist/jsonArtifacts', () => ({
  createArtifactWriter: (...args) => mockCreateArtifactWriter(...args),
}));

jest.mock('../../../lib/warchest/events', () => ({
  appendHubEvent: jest.fn(),
}));

jest.mock('../../../lib/warchest/workers/harness', () => ({
  createWorkerHarness: jest.fn(),
  safeSerializePayload: jest.fn((payload) => payload),
  spawnWorkerDetached: jest.fn(),
}));

jest.mock('../../../db', () => ({}));

const {
  validateTargetListPayload,
  runTargetListOnce,
} = require('../../../lib/warchest/workers/targetListWorker');

describe('targetListWorker payloads', () => {
  test('honors skipTargetScan flag', () => {
    const res = validateTargetListPayload({ runOnce: true, intervalMs: 1234, skipTargetScan: true });
    expect(res.skipTargetScan).toBe(true);
  });

  test('defaults skipTargetScan to false', () => {
    const res = validateTargetListPayload({ runOnce: true, intervalMs: 1234 });
    expect(res.skipTargetScan).toBe(false);
  });

  test('reports bouncer totals via progress', async () => {
    const dataClient = {
      getTokensByVolumeWithTimeframe: jest.fn().mockResolvedValue([
        { mint: 'mint-1', keep: true },
        { mint: 'mint-2', keep: false },
      ]),
      getTrendingTokens: jest.fn().mockResolvedValue({
        tokens: [
          { mint: 'mint-3', keep: true },
          { mint: 'mint-4', keep: false },
        ],
      }),
      getTopPerformersByTimeframe: jest.fn().mockResolvedValue([
        { mint: 'mint-5', keep: true },
      ]),
    };
    mockEnsureTokenInfo.mockResolvedValue(null);
    const progress = jest.fn();

    const result = await runTargetListOnce({
      dataClient,
      skipTargetScan: true,
      progress,
    });

    expect(result.totals).toEqual({ raw: 5, filtered: 3 });
    expect(progress).toHaveBeenCalledWith(
      'targetlist:counts',
      expect.objectContaining({
        totals: { raw: 5, filtered: 3 },
        uniqueMints: 3,
      })
    );
  });
});
