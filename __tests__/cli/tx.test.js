'use strict';

jest.mock('../../lib/persist/jsonArtifacts', () => ({
  sanitizeSegment: jest.fn((value) => `safe-${value}`),
}));

jest.mock('../../lib/cli/aiRun', () => ({
  createCommandRun: jest.fn(() => ({
    runId: 'run-1',
    isDev: false,
    artifacts: { write: jest.fn(), loadLatest: jest.fn() },
  })),
}));

describe('tx CLI artifacts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('buildTxArtifactRun uses aiRun.createCommandRun with sanitized segments', () => {
    const { createCommandRun } = require('../../lib/cli/aiRun');
    const { buildTxArtifactRun } = require('../../lib/cli/tx');

    const result = buildTxArtifactRun({
      txid: 'abcd1234efgh5678ijkl9012mnop3456',
      swapMode: true,
      focusWallet: { alias: 'Alpha Wallet' },
      mint: 'Mint123',
    });

    expect(createCommandRun).toHaveBeenCalledWith(expect.objectContaining({
      command: 'tx',
      segments: ['safe-Alpha Wallet', 'safe-Mint123', 'safe-abcd1234efgh5678'],
    }));
    expect(result).toEqual(expect.objectContaining({ runId: 'run-1' }));
  });
});
