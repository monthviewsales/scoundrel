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

  test('writeTxSessionArtifacts persists session payload', () => {
    const { createCommandRun } = require('../../lib/cli/aiRun');
    const { writeTxSessionArtifacts } = require('../../lib/cli/tx');
    const write = jest.fn(() => '/tmp/tx-session.json');
    createCommandRun.mockReturnValue({
      runId: 'run-2',
      isDev: false,
      artifacts: { write, loadLatest: jest.fn() },
    });

    const savedPath = writeTxSessionArtifacts({
      txid: 'sig123',
      sessionPayload: { ok: true },
      swapMode: false,
      focusWallet: null,
      mint: null,
    });

    expect(write).toHaveBeenCalledWith('response', 'txSession', { ok: true });
    expect(savedPath).toBe('/tmp/tx-session.json');
  });

  test('writeTxSessionArtifacts throws when writer fails', () => {
    const { createCommandRun } = require('../../lib/cli/aiRun');
    const { writeTxSessionArtifacts } = require('../../lib/cli/tx');
    createCommandRun.mockReturnValue({
      runId: 'run-3',
      isDev: false,
      artifacts: { write: jest.fn(() => null), loadLatest: jest.fn() },
    });

    expect(() => writeTxSessionArtifacts({
      txid: 'sig124',
      sessionPayload: { ok: false },
      swapMode: false,
      focusWallet: null,
      mint: null,
    })).toThrow('jsonArtifacts writer did not return a saved path.');
  });
});

describe('tx CLI guardrails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runTx exits when signature is missing', async () => {
    const runTx = require('../../lib/cli/tx');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runTx({ signature: '' })).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  test('runTx exits when swap mode lacks wallet or mint', async () => {
    const runTx = require('../../lib/cli/tx');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runTx({
      signature: 'sig',
      cmd: { opts: () => ({ swap: true }) },
    })).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
