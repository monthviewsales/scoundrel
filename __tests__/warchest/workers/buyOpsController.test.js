'use strict';

const mockRunSwap = jest.fn();
const mockRunTxMonitor = jest.fn();
const mockGetSolBalance = jest.fn();

jest.mock('../../../db', () => ({
  init: jest.fn(),
  listTargetsByPriority: jest.fn(),
  loadOpenPositions: jest.fn(),
  getDefaultFundingWallet: jest.fn(),
}));

jest.mock('../../../lib/bootyBoxInit', () => ({
  ensureBootyBoxInit: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../lib/warchest/workers/harness', () => ({
  forkWorkerWithPayload: jest.fn(),
}));

jest.mock('../../../lib/solanaTrackerRPCClient', () => ({
  createSolanaTrackerRPCClient: jest.fn(() => ({
    rpc: {},
    rpcSubs: {},
    close: jest.fn(),
  })),
}));

jest.mock('../../../lib/solana/rpcMethods', () => ({
  createRpcMethods: jest.fn(() => ({
    getSolBalance: mockGetSolBalance,
  })),
}));

jest.mock('../../../lib/warchest/hub', () => ({
  getHubCoordinator: jest.fn(() => ({
    runSwap: mockRunSwap,
    runTxMonitor: mockRunTxMonitor,
    runTargetList: jest.fn(),
    publishStatus: jest.fn(),
    publishHudEvent: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    paths: {},
  })),
}));

jest.mock('../../../lib/warchest/workers/sellOps/hudPublisher', () => ({
  emitToParent: jest.fn(),
}));

const BootyBox = require('../../../db');
const { forkWorkerWithPayload } = require('../../../lib/warchest/workers/harness');
const { createBuyOpsController } = require('../../../lib/warchest/workers/buyOps/controller');

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('buyOps controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSolBalance.mockResolvedValue(10);
  });

  test('dispatches a buy swap when decision is buy and regime is trend_up', async () => {
    BootyBox.getDefaultFundingWallet.mockReturnValue({
      walletId: 1,
      alias: 'warlord',
      pubkey: 'SomeWalletPubkey11111111111111111111111',
      strategy: 'hybrid',
    });
    BootyBox.listTargetsByPriority.mockReturnValue([
      { mint: 'Mint111111111111111111111111111111111', status: 'buy', score: 70 },
    ]);
    BootyBox.loadOpenPositions.mockReturnValue({ rows: [] });

    forkWorkerWithPayload.mockResolvedValue({
      result: {
        decision: 'buy',
        reasons: ['qualify:pass'],
        regime: { status: 'trend_up' },
        evaluation: {
          position: { expectedNotionalSol: 1 },
          strategy: { name: 'HYBRID' },
        },
      },
    });

    mockRunSwap.mockResolvedValue({ monitorPayload: null });

    const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const controller = createBuyOpsController({ evaluationIntervalMs: 50 }, { env: {} }, logger);
    const startPromise = controller.start();

    await flushPromises();
    await flushPromises();

    expect(mockRunSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAlias: 'warlord',
        walletId: 1,
        mint: 'Mint111111111111111111111111111111111',
        side: 'buy',
        amount: 1,
      }),
      expect.any(Object)
    );

    controller.stop('test');
    await startPromise;
  });

  test('skips buy when regime is not trend_up', async () => {
    BootyBox.getDefaultFundingWallet.mockReturnValue({
      walletId: 1,
      alias: 'warlord',
      strategy: 'hybrid',
    });
    BootyBox.listTargetsByPriority.mockReturnValue([
      { mint: 'Mint222222222222222222222222222222222', status: 'buy', score: 70 },
    ]);
    BootyBox.loadOpenPositions.mockReturnValue({ rows: [] });

    forkWorkerWithPayload.mockResolvedValue({
      result: {
        decision: 'buy',
        reasons: ['qualify:pass'],
        regime: { status: 'chop' },
        evaluation: {
          position: { expectedNotionalSol: 1 },
          strategy: { name: 'HYBRID' },
        },
      },
    });

    const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const controller = createBuyOpsController({ evaluationIntervalMs: 50 }, { env: {} }, logger);
    const startPromise = controller.start();

    await flushPromises();
    await flushPromises();

    expect(mockRunSwap).not.toHaveBeenCalled();

    controller.stop('test');
    await startPromise;
  });

  test('caps buy amount by balance pct and reserves SOL per open position', async () => {
    BootyBox.getDefaultFundingWallet.mockReturnValue({
      walletId: 1,
      alias: 'warlord',
      pubkey: 'SomeWalletPubkey11111111111111111111111',
      strategy: 'hybrid',
    });
    BootyBox.listTargetsByPriority.mockReturnValue([
      { mint: 'Mint333333333333333333333333333333333', status: 'buy', score: 70 },
    ]);
    BootyBox.loadOpenPositions.mockReturnValue({ rows: [{}, {}] });

    mockGetSolBalance.mockResolvedValue(1);
    forkWorkerWithPayload.mockResolvedValue({
      result: {
        decision: 'buy',
        reasons: ['qualify:pass'],
        regime: { status: 'trend_up' },
        evaluation: {
          position: { expectedNotionalSol: 1 },
          strategy: { name: 'HYBRID' },
        },
      },
    });

    const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const controller = createBuyOpsController(
      { evaluationIntervalMs: 50, balancePct: 0.5 },
      { env: {} },
      logger
    );
    const startPromise = controller.start();

    await flushPromises();
    await flushPromises();

    const swapPayload = mockRunSwap.mock.calls[0][0];
    expect(swapPayload.amount).toBeCloseTo(0.47, 6);

    controller.stop('test');
    await startPromise;
  });
});
