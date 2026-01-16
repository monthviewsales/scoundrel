'use strict';

const path = require('path');

jest.mock('child_process', () => {
  const listeners = new Map();
  return {
    spawn: jest.fn(() => ({
      on: (event, cb) => {
        listeners.set(event, cb);
        if (event === 'exit') {
          setImmediate(() => cb(0, null));
        }
      },
    })),
  };
});

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// HUD resolution path uses these modules when walletSpecs are absent.
jest.mock('../../lib/wallets', () => ({ selection: {} }));
jest.mock('../../lib/wallets/walletRegistry', () => ({
  listAutoAttachedWarchestWallets: jest.fn().mockResolvedValue([]),
  getDefaultFundingWallet: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/wallets/walletManagement', () => ({
  soloSelectWallet: jest.fn(),
  addWalletInteractive: jest.fn(),
  listWallets: jest.fn(),
  removeWallet: jest.fn(),
  setWalletColor: jest.fn(),
  configureWalletOptions: jest.fn(),
}));

describe('warchest HUD CLI', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('spawns HUD worker with resolved wallet args', async () => {
    const childProcess = require('child_process');
    const { hud } = require('../../lib/cli/warchest');
    const walletSpecs = ['alpha:pubkey:blue'];
    const workerPath = path.join(
      __dirname,
      '..',
      '..',
      'lib',
      'warchest',
      'workers',
      'warchestHudWorker.js',
    );

    await hud({ walletSpecs });

    expect(childProcess.spawn).toHaveBeenCalled();
    const [execPath, args, opts] = childProcess.spawn.mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args[0]).toBe(workerPath);
    expect(args).toEqual(expect.arrayContaining(['--wallet', walletSpecs[0]]));
    expect(args).toEqual(expect.arrayContaining(['--follow-hub']));
    expect(args).toEqual(expect.arrayContaining(['--hub-events', path.join(process.cwd(), 'data', 'warchest', 'tx-events.json')]));
    expect(args).toEqual(expect.arrayContaining(['--hud-state', path.join(process.cwd(), 'data', 'warchest', 'hud-state.json')]));
    expect(opts.stdio).toBe('inherit');
  });
});
