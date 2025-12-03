jest.mock('../lib/logger', () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const logger = require('../lib/logger');
const WalletManagerV2 = require('../lib/WalletManagerV2');

describe('WalletManagerV2', () => {
  const baseInsight = {
    mint: 'mint111',
    tokenDelta: 10,
    solDelta: -1.5,
    priceSolPerToken: 0.15,
    executedAt: 1710000000000,
    feesSol: 0.01,
  };

  const buildManager = (bootyBoxOverrides = {}) => {
    const bootyBox = {
      recordScTradeEvent: jest.fn(),
      applyScTradeEventToPositions: jest.fn(),
      ...bootyBoxOverrides,
    };

    const txInsightService = {
      recoverPriceFromTransactionv2: jest.fn().mockResolvedValue({ ...baseInsight }),
    };

    return {
      manager: new WalletManagerV2({
        rpc: {},
        walletId: 1,
        walletAlias: 'alpha',
        walletPubkey: 'pub111',
        txInsightService,
        tokenPriceService: null,
        bootyBox,
        strategyContextProvider: null,
      }),
      bootyBox,
      txInsightService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('continues applying positions when trade recording fails', async () => {
    const erroringBooty = {
      recordScTradeEvent: jest.fn(() => {
        throw new Error('db down');
      }),
    };

    const { manager, bootyBox } = buildManager(erroringBooty);

    await manager.processSignature('sig-123');

    expect(bootyBox.recordScTradeEvent).toHaveBeenCalledTimes(1);
    expect(bootyBox.applyScTradeEventToPositions).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs and skips when BootyBox persistence helpers are missing', async () => {
    const { manager } = buildManager({ applyScTradeEventToPositions: undefined });

    await manager.processSignature('sig-456');

    expect(logger.warn).toHaveBeenCalled();
  });
});
