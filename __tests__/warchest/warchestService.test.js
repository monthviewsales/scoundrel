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

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  solanaTrackerData: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

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
