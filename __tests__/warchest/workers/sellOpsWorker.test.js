'use strict';

jest.mock('../../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../../db/src/adapters/sqlite', () => ({
  init: jest.fn(),
  loadOpenPositions: jest.fn(),
  modules: {
    context: {
      db: {},
    },
  },
}));

jest.mock('../../../lib/warchest/client', () => ({
  setup: jest.fn(),
}));

jest.mock('../../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(),
}));

jest.mock('../../../db/src/services/evaluationService', () => ({
  buildEvaluation: jest.fn(),
}));

const BootyBox = require('../../../db/src/adapters/sqlite');
const { setup } = require('../../../lib/warchest/client');
const { createSolanaTrackerDataClient } = require('../../../lib/solanaTrackerDataClient');
const { buildEvaluation } = require('../../../db/src/services/evaluationService');
const { createSellOpsController } = require('../../../lib/warchest/workers/sellOpsWorker');

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('sellOps worker controller', () => {
  let originalSend;
  beforeEach(() => {
    originalSend = process.send;
    process.send = jest.fn();
    BootyBox.init.mockClear();
    BootyBox.loadOpenPositions.mockReset();
    setup.mockReset();
    createSolanaTrackerDataClient.mockReset();
    buildEvaluation.mockReset();
  });

  afterEach(() => {
    process.send = originalSend;
    jest.useRealTimers();
  });

  test('emits evaluation snapshots for open positions', async () => {
    const row = {
      position_id: 1,
      wallet_id: 7,
      wallet_alias: 'alpha',
      coin_mint: 'mint-1',
      trade_uuid: 'trade-1',
      strategy_id: 'strat-1',
      strategy_name: 'Strat',
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
      source: 'swap',
    };

    BootyBox.loadOpenPositions.mockReturnValue({ rows: [row] });
    buildEvaluation.mockResolvedValue({
      evaluation: {
        coin: { priceUsd: 1.2 },
        pool: { liquidity_usd: 250 },
        pnl: { unrealized_usd: 5, total_usd: 9 },
        derived: { roiUnrealizedPct: 10 },
        chart: {
          type: '1m',
          points: 10,
          poolAddress: 'pool-1',
          timeFrom: 1,
          timeTo: 2,
        },
        indicators: {
          rsi: 55,
          atr: 0.2,
          emaFast: 1.1,
          emaSlow: 1.0,
          macd: { hist: 0.01 },
          vwap: 1.05,
          vwapVolume: 100,
          lastClose: 1.1,
        },
        warnings: [],
      },
      warnings: [],
    });

    const dataClient = { close: jest.fn() };
    const client = { close: jest.fn() };
    const track = jest.fn();

    const controller = createSellOpsController(
      { wallet: { alias: 'alpha', pubkey: 'pub' }, pollIntervalMs: 1000 },
      { client, dataClient, db: {}, track, env: {} }
    );

    const promise = controller.start();
    await flushPromises();

    const messages = process.send.mock.calls.map(([msg]) => msg);
    const evaluationMsg = messages.find((msg) => msg.type === 'sellOps:evaluation');
    expect(evaluationMsg).toBeTruthy();
    expect(evaluationMsg.payload.walletAlias).toBe('alpha');
    expect(evaluationMsg.payload.mint).toBe('mint-1');
    expect(evaluationMsg.payload.regime.status).toBe('trend_up');
    expect(evaluationMsg.payload.indicators.macdHist).toBeCloseTo(0.01);

    const result = await controller.stop('unit-test');
    expect(result.status).toBe('stopped');
    expect(result.stopReason).toBe('unit-test');
    expect(dataClient.close).toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(createSolanaTrackerDataClient).not.toHaveBeenCalled();

    await promise;
  });

  test('emits alert when cost basis is missing for trailing stop', async () => {
    jest.useFakeTimers();

    const row = {
      position_id: 1,
      wallet_id: 7,
      wallet_alias: 'alpha',
      coin_mint: 'mint-1',
      trade_uuid: 'trade-1',
      open_at: 111,
      closed_at: 0,
      last_trade_at: 222,
      last_updated_at: 333,
      entry_token_amount: 100,
      current_token_amount: 100,
      total_tokens_bought: 100,
      total_tokens_sold: 0,
      entry_price_sol: 0.01,
      entry_price_usd: null,
      last_price_sol: 0.011,
      last_price_usd: 1.1,
      source: 'swap',
    };

    BootyBox.loadOpenPositions.mockReturnValue({ rows: [row] });
    buildEvaluation.mockResolvedValue({
      evaluation: {
        symbol: 'ROCK',
        coin: { priceUsd: 1.2 },
        pnl: {},
        chart: {
          type: '1m',
          points: 10,
          poolAddress: 'pool-1',
          timeFrom: 1,
          timeTo: 2,
        },
        indicators: {
          rsi: 55,
          atr: 0.2,
          emaFast: 1.1,
          emaSlow: 1.0,
          macd: { hist: 0.01 },
          vwap: 1.05,
          vwapVolume: 100,
          lastClose: 1.1,
        },
        warnings: [],
      },
      warnings: [],
    });

    const dataClient = {
      close: jest.fn(),
      getMultipleTokenPrices: jest.fn().mockResolvedValue({
        'mint-1': { price: 1.2 },
      }),
    };

    const controller = createSellOpsController(
      { wallet: { alias: 'alpha', pubkey: 'pub' }, pollIntervalMs: 1000, trailingPollMs: 1000 },
      { client: { close: jest.fn() }, dataClient, db: {}, track: jest.fn(), env: {} }
    );

    const promise = controller.start();
    await jest.advanceTimersByTimeAsync(1100);

    const messages = process.send.mock.calls.map(([msg]) => msg);
    const alertMsg = messages.find((msg) => msg.type === 'sellOps:alert');
    expect(alertMsg).toBeTruthy();
    expect(alertMsg.payload.message).toBe('ROCK missing entry_price_usd; stop not armed!');

    await controller.stop('unit-test');
    await promise;
  });

  test('emits heartbeat when no open positions are found', async () => {
    BootyBox.loadOpenPositions.mockReturnValue({ rows: [] });
    buildEvaluation.mockResolvedValue({ evaluation: {}, warnings: [] });

    const controller = createSellOpsController(
      { wallet: { alias: 'alpha' }, pollIntervalMs: 1000 },
      { client: { close: jest.fn() }, dataClient: { close: jest.fn() }, db: {}, track: jest.fn(), env: {} }
    );

    const promise = controller.start();
    await flushPromises();

    const messages = process.send.mock.calls.map(([msg]) => msg);
    const heartbeatMsg = messages.find((msg) => msg.type === 'sellOps:heartbeat');
    expect(heartbeatMsg).toBeTruthy();
    expect(heartbeatMsg.payload.openPositions).toBe(0);
    expect(heartbeatMsg.payload.walletAlias).toBe('alpha');

    await controller.stop('done');
    await promise;
  });

  test('requires a wallet alias', () => {
    expect(() => createSellOpsController({})).toThrow(/wallet alias/i);
  });

  test('runs autopsy when a position closes between ticks', async () => {
    const row = {
      position_id: 1,
      wallet_id: 7,
      wallet_alias: 'alpha',
      coin_mint: 'mint-1',
      trade_uuid: 'trade-1',
      strategy_id: 'strat-1',
      strategy_name: 'Strat',
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
      source: 'swap',
    };

    BootyBox.loadOpenPositions
      .mockReturnValueOnce({ rows: [row] })
      .mockReturnValueOnce({ rows: [] });
    buildEvaluation.mockResolvedValue({
      evaluation: { indicators: {}, chart: {} },
      warnings: [],
    });

    const runAutopsy = jest.fn().mockResolvedValue({
      ai: { grade: 'B', summary: 'Recovered', tags: ['test'] },
      artifactPath: '/tmp/autopsy.json',
    });

    const controller = createSellOpsController(
      { wallet: { alias: 'alpha', pubkey: 'pub' }, pollIntervalMs: 10 },
      { client: { close: jest.fn() }, dataClient: { close: jest.fn() }, db: {}, track: jest.fn(), env: {}, runAutopsy }
    );

    const promise = controller.start();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPromises();

    const messages = process.send.mock.calls.map(([msg]) => msg);
    const autopsyMsg = messages.find((msg) => msg.type === 'sellOps:autopsy');
    expect(autopsyMsg).toBeTruthy();
    expect(autopsyMsg.payload.tradeUuid).toBe('trade-1');
    expect(autopsyMsg.payload.grade).toBe('B');
    expect(autopsyMsg.payload.summary).toBe('Recovered');
    expect(runAutopsy).toHaveBeenCalledWith({
      walletAddress: 'pub',
      mint: 'mint-1',
      walletLabel: 'alpha',
    });

    await controller.stop('done');
    await promise;
  });
});
