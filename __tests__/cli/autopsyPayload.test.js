'use strict';

const mockEnsureTokenInfo = jest.fn();
const mockCreateArtifactWriter = jest.fn();

jest.mock('../../lib/services/tokenInfoService', () => ({
  ensureTokenInfo: (...args) => mockEnsureTokenInfo(...args),
}));

jest.mock('../../lib/persist/jsonArtifacts', () => ({
  ...jest.requireActual('../../lib/persist/jsonArtifacts'),
  createArtifactWriter: (...args) => mockCreateArtifactWriter(...args),
}));

describe('buildAutopsyPayload', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('builds payload and computes USD metrics', async () => {
    mockEnsureTokenInfo.mockResolvedValue({
      symbol: 'TST',
      name: 'TestToken',
      decimals: 6,
    });

    const write = jest.fn(() => '/tmp/autopsy.json');
    mockCreateArtifactWriter.mockReturnValue({ write });

    const client = {
      getUserTokenTrades: jest.fn().mockResolvedValue({
        trades: [
          { side: 'buy', amount: 10, priceUsd: 1, time: 1000 },
          { side: 'sell', amount: 10, priceUsd: 3, time: 2000 },
        ],
      }),
      getPriceRange: jest.fn().mockResolvedValue({ min: 1, max: 3 }),
      getTokenPnL: jest.fn().mockResolvedValue({ realized: 20, total_invested: 10 }),
      getAthPrice: jest.fn().mockResolvedValue({ price: 5 }),
      getTokenOhlcvData: jest.fn().mockResolvedValue({
        oclhv: [
          { time: 1, open: 1, close: 2, low: 0.9, high: 2.1, volume: 100 },
        ],
      }),
    };

    const { buildAutopsyPayload } = require('../../lib/cli/autopsy');

    const { payload } = await buildAutopsyPayload({
      walletLabel: 'Trader',
      walletAddress: 'Wallet1',
      mint: 'Mint1',
      client,
      runId: 'run-123',
    });

    expect(payload.wallet).toEqual({ label: 'Trader', address: 'Wallet1' });
    expect(payload.token.symbol).toBe('TST');
    expect(payload.campaign.metrics.realizedPnLUsd).toBe(20);
    expect(payload.campaign.metrics.avgEntryPrice).toBe(1);
    expect(payload.campaign.metrics.avgExitPrice).toBe(3);
    expect(payload.campaign.metrics.feeToPnLRatio).toBeNull();

    expect(write).toHaveBeenCalledWith('raw', 'tokenInfo', expect.any(Object));
    expect(write).toHaveBeenCalledWith('raw', 'userTokenTrades', expect.any(Object));
    expect(write).toHaveBeenCalledWith('raw', 'ohlcv', expect.any(Object));
    expect(write).toHaveBeenCalledWith('prompt', 'prompt', payload);
  });
});
