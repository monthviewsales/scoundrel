'use strict';

jest.mock('../../../lib/warchest/workers/harness', () => ({
  createWorkerHarness: jest.fn(),
  safeSerializePayload: jest.fn((payload) => payload),
}));

jest.mock('../../../lib/cli/devscan', () => ({
  runDevscan: jest.fn(),
}));

const { runDevscan } = require('../../../lib/cli/devscan');
const {
  validateDevscanPayload,
  runDevscanWorker,
} = require('../../../lib/warchest/workers/devscanWorker');

describe('devscan worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('validates required payload fields', () => {
    expect(() => validateDevscanPayload({})).toThrow(
      'Devscan payload requires at least one of mint, developerWallet, or developerTokensWallet',
    );
  });

  test('runs devscan with normalized payload', async () => {
    runDevscan.mockResolvedValue({ ok: true });

    const result = await runDevscanWorker({
      mint: ' MintA ',
      developerWallet: ' DevWallet ',
      runAnalysis: false,
    });

    expect(runDevscan).toHaveBeenCalledWith({
      mint: 'MintA',
      developerWallet: 'DevWallet',
      runAnalysis: false,
    });
    expect(result).toEqual({ ok: true });
  });
});
