"use strict";

jest.mock("../../../lib/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../../../db/src/adapters/sqlite", () => ({
  init: jest.fn(),
  loadOpenPositions: jest.fn(),
  modules: {
    context: {
      db: {},
    },
  },
}));

jest.mock("../../../lib/warchest/client", () => ({
  setup: jest.fn(),
}));

jest.mock("../../../lib/solanaTrackerDataClient", () => ({
  createSolanaTrackerDataClient: jest.fn(),
}));

jest.mock("../../../lib/warchest/workers/sellOps/evaluationEngine", () => ({
  DEFAULT_EVENT_INTERVALS: ["5m", "15m"],
  evaluatePosition: jest.fn(),
}));

const BootyBox = require("../../../db/src/adapters/sqlite");
const {
  evaluatePosition,
} = require("../../../lib/warchest/workers/sellOps/evaluationEngine");
const {
  createSellOpsController,
} = require("../../../lib/warchest/workers/sellOps/controller");

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

describe("sellOps observeOnly defaults", () => {
  let originalSend;

  beforeEach(() => {
    originalSend = process.send;
    BootyBox.init.mockClear();
    BootyBox.loadOpenPositions.mockReset();
    evaluatePosition.mockReset();
    process.send = jest.fn();
  });

  afterEach(() => {
    process.send = originalSend;
    jest.useRealTimers();
  });

  test("defaults to execute mode in production env", async () => {
    jest.useFakeTimers();

    BootyBox.loadOpenPositions.mockReturnValue({
      rows: [
        {
          position_id: 1,
          wallet_id: 7,
          wallet_alias: "alpha",
          coin_mint: "mint-1",
          trade_uuid: "trade-1",
          open_at: 111,
          closed_at: 0,
          last_trade_at: 222,
          last_updated_at: 333,
          entry_token_amount: 100,
          current_token_amount: 100,
          total_tokens_bought: 100,
          total_tokens_sold: 0,
          entry_price_sol: 0.01,
          entry_price_usd: 1,
          last_price_sol: 0.011,
          last_price_usd: 1.1,
          source: "swap",
        },
      ],
    });

    evaluatePosition.mockResolvedValue({
      decision: "hold",
      reasons: [],
      evaluation: { indicators: {}, chart: {} },
    });

    const controller = createSellOpsController(
      { wallet: { alias: "alpha", pubkey: "pub" }, pollIntervalMs: 1000 },
      {
        client: { close: jest.fn() },
        dataClient: {
          close: jest.fn(),
          getMultipleTokenPrices: jest.fn().mockImplementation(() => ({
            "mint-1": { price: 1.1, lastUpdated: Date.now() },
          })),
        },
        db: {},
        track: jest.fn(),
        env: { NODE_ENV: "production" },
      }
    );

    const promise = controller.start();
    await flushPromises();

    jest.advanceTimersByTime(1100);
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(evaluatePosition).toHaveBeenCalled();
    const calls = evaluatePosition.mock.calls.map((c) => c[0]);
    const anyExecuteMode = calls.some(
      (a) => a && a.payload && a.payload.observeOnly === false
    );
    expect(anyExecuteMode).toBe(true);

    await controller.stop("unit-test");
    // Drain any pending timers scheduled by the fast loop/slow tick so the controller can resolve.
    jest.runOnlyPendingTimers();
    await flushPromises();

    await promise;
  });

  test("honors explicit observeOnly override", async () => {
    BootyBox.loadOpenPositions.mockReturnValue({
      rows: [
        {
          position_id: 1,
          wallet_id: 7,
          wallet_alias: "alpha",
          coin_mint: "mint-1",
          trade_uuid: "trade-1",
          open_at: 111,
          closed_at: 0,
          last_trade_at: 222,
          last_updated_at: 333,
          entry_token_amount: 100,
          current_token_amount: 100,
          total_tokens_bought: 100,
          total_tokens_sold: 0,
          entry_price_sol: 0.01,
          entry_price_usd: 1,
          last_price_sol: 0.011,
          last_price_usd: 1.1,
          source: "swap",
        },
      ],
    });

    evaluatePosition.mockResolvedValue({
      decision: "hold",
      reasons: [],
      evaluation: { indicators: {}, chart: {} },
    });

    const controller = createSellOpsController(
      {
        wallet: { alias: "alpha", pubkey: "pub" },
        pollIntervalMs: 1000,
        observeOnly: true,
      },
      {
        client: { close: jest.fn() },
        dataClient: { close: jest.fn() },
        db: {},
        track: jest.fn(),
        env: { NODE_ENV: "production" },
      }
    );

    const promise = controller.start();
    await flushPromises();

    const args = evaluatePosition.mock.calls[0][0];
    expect(args.payload.observeOnly).toBe(true);

    await controller.stop("unit-test");
    await promise;
  });
});
