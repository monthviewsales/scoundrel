// __tests__/warchest/workers/buyOps/buyOpsStrategyHandoff.test.js
"use strict";

// Ensures that when BuyOps buys under a wallet-level strategy (e.g., HYBRID),
// the newly opened position is best-effort updated with that strategy name so SellOps won't
// treat it as "inferred".

jest.mock("../../../../db", () => ({
  getDefaultFundingWallet: jest.fn(),
  listTargetsByPriority: jest.fn(),
  loadOpenPositions: jest.fn(),
  addUpdateTarget: jest.fn(),
  updatePositionStrategyName: jest.fn(),
}));

jest.mock("../../../../lib/bootyBoxInit.js", () => ({
  ensureBootyBoxInit: jest.fn(async () => true),
}));

jest.mock("../../../../lib/warchest/hub", () => ({
  getHubCoordinator: jest.fn(() => ({
    runSwap: jest.fn(async () => ({ result: { txid: "tx-1" } })),
    runTxMonitor: jest.fn(async () => ({ status: "ok" })),
  })),
}));

jest.mock("../../../../lib/solanaTrackerRPCClient", () => ({
  createSolanaTrackerRPCClient: jest.fn(() => ({
    rpc: {},
    rpcSubs: {},
    close: jest.fn(async () => undefined),
  })),
}));

jest.mock("../../../../lib/solana/rpcMethods", () => ({
  createRpcMethods: jest.fn(() => ({
    getSolBalance: jest.fn(async () => 10), // plenty of SOL
  })),
}));

jest.mock("../../../../lib/warchest/workers/harness", () => ({
  forkWorkerWithPayload: jest.fn(),
}));

jest.mock("../../../../lib/warchest/workers/sellOps/strategyDocs", () => ({
  loadStrategyDocs: jest.fn(() => ({
    flash: { name: "FLASH", strategyId: "flash-1" },
    hybrid: { name: "HYBRID", strategyId: "hybrid-1" },
    campaign: { name: "CAMPAIGN", strategyId: "campaign-1" },
  })),
}));

jest.mock("../../../../lib/warchest/workers/sellOps/hudPublisher", () => ({
  emitToParent: jest.fn(),
}));

jest.mock("../../../../lib/warchest/workers/sellOps/positionAdapter", () => ({
  toPositionSummary: jest.fn((row) => ({
    positionId: row.position_id,
    walletId: row.wallet_id,
    walletAlias: row.wallet_alias,
    mint: row.coin_mint,
    tradeUuid: row.trade_uuid || null,
    currentTokenAmount: row.current_token_amount,
    strategyName: row.strategy_name || null,
    strategyId: row.strategy_id || null,
    source: "buyOps",
  })),
}));

jest.mock("../../../../lib/warchest/workers/buyOps/persistence", () => ({
  persistBuyOpsEvaluation: jest.fn(),
}));

const BootyBox = require("../../../../db");
const {
  forkWorkerWithPayload,
} = require("../../../../lib/warchest/workers/harness");
const {
  createBuyOpsController,
} = require("../../../../lib/warchest/workers/buyOps/controller");

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

describe("buyOps strategy handoff", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    // Wallet strategy set to HYBRID.
    BootyBox.getDefaultFundingWallet.mockReturnValue({
      walletId: 1,
      alias: "alpha",
      pubkey: "pubkey-1",
      strategy: "HYBRID",
    });

    // One target eligible for evaluation.
    BootyBox.listTargetsByPriority.mockReturnValue([
      {
        mint: "mint-1",
        symbol: "M1",
        name: "Mint One",
        status: "buy",
        score: 90,
        confidence: 0.9,
      },
    ]);

    // loadOpenPositions is called in multiple places:
    // - initial open positions lookup during evaluation tick
    // - post-buy best-effort strategy updater retries
    // We'll return no positions initially, then return the opened position later.
    const openedRow = {
      position_id: 99,
      wallet_id: 1,
      wallet_alias: "alpha",
      coin_mint: "mint-1",
      trade_uuid: "trade-99",
      current_token_amount: 123,
    };

    BootyBox.loadOpenPositions
      .mockReturnValueOnce({ rows: [] }) // initial open positions check
      .mockReturnValueOnce({ rows: [] }) // updater attempt 1
      .mockReturnValueOnce({ rows: [] }) // updater attempt 2
      .mockReturnValueOnce({ rows: [openedRow] }); // updater attempt 3 succeeds

    // Eval worker returns BUY + trend_up + strategy HYBRID + expectedNotionalSol
    forkWorkerWithPayload.mockResolvedValue({
      result: {
        decision: "buy",
        reasons: ["unit_test_buy"],
        regime: { status: "trend_up" },
        chosenStrategy: { name: "HYBRID", strategyId: "hybrid-1" },
        evaluation: {
          strategy: { name: "HYBRID", strategyId: "hybrid-1" },
          position: { expectedNotionalSol: 0.25 },
        },
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("updates newly opened position strategy name after buy", async () => {
    const controller = createBuyOpsController(
      {
        // keep evaluation interval enabled; bootstrap runs an immediate tick
        evaluationIntervalMs: 60_000,
        evalTimeoutMs: 5_000,
        evaluationConcurrency: 1,
        minScore: 65,
        balancePct: "100%", // allow full available
      },
      { env: { NODE_ENV: "production" } },
      console
    );

    const startPromise = controller.start();

    // Let bootstrap start and evaluation tick run.
    await flushPromises();

    // The controller's worker loop yields with setImmediate; under fake timers we need to flush.
    jest.runOnlyPendingTimers();
    await flushPromises();

    // Advance timers enough for the post-buy retry loop (max 250+500+1000 = 1750ms to hit 3rd attempt).
    jest.advanceTimersByTime(2000);
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(BootyBox.updatePositionStrategyName).toHaveBeenCalled();
    const calls = BootyBox.updatePositionStrategyName.mock.calls;
    const anyHybrid = calls.some(
      (c) => c[0] && c[0].positionId === 99 && c[0].strategyName === "HYBRID"
    );
    expect(anyHybrid).toBe(true);

    await controller.stop("unit-test");
    jest.runOnlyPendingTimers();
    await flushPromises();

    await startPromise;
  }, 10_000);
});
