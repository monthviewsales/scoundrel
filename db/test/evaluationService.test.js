'use strict';

const { createIsolatedAdapter, cleanDatabase } = require('./helpers/sqliteTestUtils');
const { buildEvaluation } = require('../src/services/evaluationService');

let adapter;
let context;

function buildCandles(count, startPrice) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + 0.1;
    const high = close + 0.05;
    const low = open - 0.05;
    candles.push({
      t: 1000 + i * 60,
      o: open,
      h: high,
      l: low,
      c: close,
      v: 10 + i,
    });
    price = close;
  }
  return candles;
}

describe('evaluationService', () => {
  beforeAll(() => {
    ({ adapter, context } = createIsolatedAdapter());
  });

  beforeEach(() => {
    cleanDatabase(context);
  });

  test('buildEvaluation composes a full snapshot with indicators and derived metrics', async () => {
    const now = Date.now();
    const mint = 'mint-eval-1';

    adapter.addOrUpdateCoin({
      mint,
      symbol: 'EVAL',
      name: 'Eval Token',
      status: 'complete',
      priceUsd: 2,
      priceSol: 0.1,
      liquidityUsd: 500,
      pools: [
        {
          poolId: 'pool-1',
          price: { quote: 0.1, usd: 2 },
          liquidity: { quote: 10, usd: 500 },
          marketCap: { quote: 100, usd: 2000 },
          market: 'raydium',
          quoteToken: 'SOL',
          createdAt: now - 1000,
        },
      ],
      events: {
        '5m': { priceChangePercentage: 1, volume: { usd: 100, quote: 5 }, buys: 2, sells: 1, txns: 3, wallets: 4 },
        '15m': { priceChangePercentage: 2, volume: { usd: 150, quote: 7 }, buys: 3, sells: 2, txns: 5, wallets: 6 },
        '1h': { priceChangePercentage: 3, volume: { usd: 200, quote: 9 }, buys: 4, sells: 3, txns: 7, wallets: 8 },
      },
      risk: {
        score: 7,
        rugged: false,
        snipers: { count: 0, totalBalance: 0, totalPercentage: 0 },
        insiders: { count: 0, totalBalance: 0, totalPercentage: 0 },
        dev: { percentage: 1.5, amount: 100 },
        fees: { total: 0 },
        risks: [],
      },
    });

    const openPosition = adapter.ensureOpenPositionRun({
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: mint,
      currentTokenAmount: 100,
      openAt: now,
    }).position;

    context.db.prepare(
      `INSERT INTO sc_pnl_positions (
        wallet_id,
        wallet_alias,
        coin_mint,
        trade_uuid,
        total_tokens_bought,
        total_tokens_sold,
        total_sol_spent,
        total_sol_received,
        fees_sol,
        fees_usd,
        avg_cost_sol,
        avg_cost_usd,
        realized_sol,
        realized_usd,
        first_trade_at,
        last_trade_at,
        last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      'alpha',
      mint,
      openPosition.trade_uuid,
      100,
      0,
      10,
      0,
      0,
      0,
      0.5,
      1,
      0,
      0,
      now,
      now,
      now
    );

    const dataClient = {
      client: {
        getPoolChartData: jest.fn(() => ({ ohlcv: buildCandles(40, 1) })),
      },
    };

    const { evaluation, warnings } = await buildEvaluation({
      db: context.db,
      position: {
        walletId: 1,
        walletAlias: 'alpha',
        mint,
        tradeUuid: openPosition.trade_uuid,
      },
      dataClient,
      nowMs: now,
      includeCandles: true,
      ohlcv: { type: '1m', lookbackMs: 60 * 60 * 1000 },
      indicators: { vwapPeriods: 20 },
    });

    expect(warnings).toHaveLength(0);
    expect(evaluation.coin.mint).toBe(mint);
    expect(evaluation.pool.id).toBe('pool-1');
    expect(evaluation.events['5m']).toBeTruthy();
    expect(evaluation.risk.riskScore).toBe(7);
    expect(evaluation.pnl.trade_uuid).toBe(openPosition.trade_uuid);
    expect(evaluation.chart.candles).toHaveLength(40);
    expect(evaluation.indicators.macd.hist).not.toBeNull();

    expect(evaluation.derived.positionValueUsd).toBeCloseTo(200);
    expect(evaluation.derived.costBasisUsd).toBeCloseTo(100);
    expect(evaluation.derived.roiUnrealizedPct).toBeCloseTo(100);
  });
});
