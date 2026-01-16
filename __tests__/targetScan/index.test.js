'use strict';

jest.mock('../../lib/cli/analysisFlow', () => {
  const flow = jest.fn();
  return {
    createAnalysisFlow: jest.fn(() => flow),
    __flow: flow,
  };
});

jest.mock('../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(),
}));

const { createSolanaTrackerDataClient } = require('../../lib/solanaTrackerDataClient');
const { __flow } = require('../../lib/cli/analysisFlow');

describe('targetScan helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizeMintList de-dupes and trims', () => {
    const { normalizeMintList } = require('../../lib/targetScan');
    const result = normalizeMintList(['Mint1', 'mint1', 'Mint2, Mint3', null, '']);

    expect(result).toEqual(['Mint1', 'Mint2', 'Mint3']);
  });

  test('normalizeTargetScanOptions sets defaults', () => {
    const { normalizeTargetScanOptions } = require('../../lib/targetScan');
    const result = normalizeTargetScanOptions({ mint: 'Mint1', concurrency: '2' });

    expect(result).toEqual(expect.objectContaining({
      mints: ['Mint1'],
      runAnalysis: true,
      concurrency: 2,
    }));
  });
});

describe('runTargetScan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires at least one mint', async () => {
    const { runTargetScan } = require('../../lib/targetScan');
    await expect(runTargetScan({})).rejects.toThrow('[targetScan] requires at least one mint');
  });

  test('executes flow per mint and closes shared client', async () => {
    const close = jest.fn();
    createSolanaTrackerDataClient.mockReturnValue({ close });
    __flow.mockResolvedValue({
      payload: { ok: true },
      analysis: { ok: true },
      promptPath: '/tmp/prompt.json',
      responsePath: '/tmp/response.json',
    });

    const { runTargetScan } = require('../../lib/targetScan');
    const result = await runTargetScan({
      mints: ['MintA', 'MintB'],
      concurrency: 1,
      runAnalysis: false,
    });

    expect(__flow).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
    expect(close).toHaveBeenCalled();
  });
});
