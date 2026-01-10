'use strict';

jest.mock('../../db', () => ({
  getPnlPositionsLive: jest.fn(),
}));

jest.mock('../../lib/warchest/workers/workerLogger', () => ({
  createWorkerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({})),
}));

jest.mock('../../lib/services/txInsightService', () => ({}));

jest.mock('../../lib/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => logger),
  };
  return {
    ...logger,
    solanaTrackerData: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  };
});

describe('refreshPnlPositionsForWallet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('keeps rows that only provide currentTokenAmount', async () => {
    const BootyBox = require('../../db');
    BootyBox.getPnlPositionsLive.mockResolvedValue([
      {
        coin_mint: 'mint1',
        currentTokenAmount: '12.5',
        avg_cost_usd: 1,
        coin_price_usd: 2,
      },
    ]);

    const { refreshPnlPositionsForWallet } = require('../../lib/warchest/workers/warchestService');

    const wallet = { walletId: 7, alias: 'alpha' };
    await refreshPnlPositionsForWallet(wallet);

    expect(BootyBox.getPnlPositionsLive).toHaveBeenCalledWith({ walletId: 7 });
    expect(wallet.pnlByMint).toHaveProperty('mint1');
    expect(wallet.pnlByMint.mint1.current_token_amount).toBeCloseTo(12.5);
    expect(wallet.pnlByMint.mint1.currentTokenAmount).toBeCloseTo(12.5);
  });
});

describe('createWalletTokenRefreshScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('debounces and queues refreshes without overlap', async () => {
    process.env.WARCHEST_LOG_REFRESH_DEBOUNCE_MS = '5';
    jest.useFakeTimers();

    const deferred = () => {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    const firstBalances = deferred();
    const firstPnl = deferred();
    const secondBalances = deferred();
    const secondPnl = deferred();

    let createWalletTokenRefreshScheduler;
    jest.isolateModules(() => {
      ({ createWalletTokenRefreshScheduler } = require('../../lib/warchest/workers/warchestService'));
    });

    const refreshTokenBalances = jest
      .fn()
      .mockImplementationOnce(() => firstBalances.promise)
      .mockImplementationOnce(() => secondBalances.promise);
    const refreshPnlPositions = jest
      .fn()
      .mockImplementationOnce(() => firstPnl.promise)
      .mockImplementationOnce(() => secondPnl.promise);
    const emitHudChange = jest.fn();
    const getRpcMethods = jest.fn(() => ({}));
    const state = {
      alpha: { alias: 'alpha', pubkey: 'PUB', tokens: [] },
    };

    const schedule = createWalletTokenRefreshScheduler({
      state,
      getRpcMethods,
      emitHudChange,
      refreshTokenBalances,
      refreshPnlPositions,
    });

    schedule('alpha', 'log');
    schedule('alpha', 'log2');

    await jest.advanceTimersByTimeAsync(5);
    expect(refreshTokenBalances).toHaveBeenCalledTimes(1);
    expect(refreshPnlPositions).toHaveBeenCalledTimes(0);

    schedule('alpha', 'log3');

    firstBalances.resolve();
    firstPnl.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(5);
    secondBalances.resolve();
    secondPnl.resolve();
    await Promise.resolve();

    expect(refreshTokenBalances).toHaveBeenCalledTimes(2);
    expect(refreshPnlPositions).toHaveBeenCalledTimes(2);
    expect(emitHudChange).toHaveBeenCalled();

    jest.useRealTimers();
    delete process.env.WARCHEST_LOG_REFRESH_DEBOUNCE_MS;
  });
});
