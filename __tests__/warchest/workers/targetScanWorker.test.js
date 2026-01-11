'use strict';

jest.mock('../../../lib/warchest/workers/harness', () => ({
  createWorkerHarness: jest.fn(),
  safeSerializePayload: jest.fn((payload) => payload),
}));

jest.mock('../../../lib/targetScan', () => ({
  runTargetScan: jest.fn(),
}));

const { runTargetScan } = require('../../../lib/targetScan');
const {
  validateTargetScanPayload,
  runTargetScanWorker,
} = require('../../../lib/warchest/workers/targetScanWorker');

describe('targetScan worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes runAnalysis and concurrency', () => {
    const result = validateTargetScanPayload({
      mint: 'MintA',
      concurrency: '3',
      runAnalysis: 'false',
    });

    expect(result).toEqual(expect.objectContaining({
      mint: 'MintA',
      concurrency: 3,
      runAnalysis: false,
    }));
  });

  test('runs target scan with normalized payload', async () => {
    runTargetScan.mockResolvedValue({ ok: true });

    const result = await runTargetScanWorker({
      mints: ['MintA', 'MintB'],
      runAnalysis: true,
    });

    expect(runTargetScan).toHaveBeenCalledWith({ mints: ['MintA', 'MintB'], runAnalysis: true });
    expect(result).toEqual({ ok: true });
  });
});
