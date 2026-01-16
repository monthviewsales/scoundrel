'use strict';

const { createIsolatedAdapter, cleanDatabase } = require('./helpers/sqliteTestUtils');

let adapter;
let context;

beforeAll(() => {
  ({ adapter, context } = createIsolatedAdapter());
});

beforeEach(() => {
  cleanDatabase(context);
});

test('rebuildScPnlForWalletMint recomputes totals and position rollups', () => {
  const walletId = 1;
  const coinMint = 'mint-abc';
  const tradeUuid = 'trade-uuid-1';

  adapter.insertScTrades([
    {
      walletId,
      walletAlias: 'main',
      coinMint,
      tradeUuid,
      txid: 'tx-1',
      side: 'buy',
      executedAt: 1000,
      tokenAmount: 10,
      solAmount: 1,
      solUsdPrice: 100,
    },
    {
      walletId,
      walletAlias: 'main',
      coinMint,
      tradeUuid,
      txid: 'tx-2',
      side: 'buy',
      executedAt: 2000,
      tokenAmount: 5,
      solAmount: 1,
      solUsdPrice: 120,
    },
    {
      walletId,
      walletAlias: 'main',
      coinMint,
      tradeUuid,
      txid: 'tx-3',
      side: 'sell',
      executedAt: 3000,
      tokenAmount: 8,
      solAmount: 1.6,
      solUsdPrice: 130,
    },
  ]);

  const result = adapter.rebuildScPnlForWalletMint({ walletId, coinMint });

  expect(result).toEqual({
    cleared: false,
    tradeCount: 3,
    positionCount: 1,
  });

  const pnl = context.db
    .prepare('SELECT * FROM sc_pnl WHERE wallet_id = ? AND coin_mint = ?')
    .get(walletId, coinMint);

  expect(Number(pnl.total_tokens_bought)).toBeCloseTo(15, 6);
  expect(Number(pnl.total_tokens_sold)).toBeCloseTo(8, 6);
  expect(Number(pnl.total_sol_spent)).toBeCloseTo(2, 6);
  expect(Number(pnl.total_sol_received)).toBeCloseTo(1.6, 6);
  expect(Number(pnl.avg_cost_sol)).toBeCloseTo(2 / 15, 6);
  expect(Number(pnl.avg_cost_usd)).toBeCloseTo(16, 6);
  expect(Number(pnl.realized_sol)).toBeCloseTo(1.6 - (8 * (2 / 15)), 6);
  expect(Number(pnl.realized_usd)).toBeCloseTo((1.6 - (8 * (2 / 15))) * 130, 6);
  expect(pnl.first_trade_at).toBe(1000);
  expect(pnl.last_trade_at).toBe(3000);

  const pnlPosition = context.db
    .prepare(
      'SELECT * FROM sc_pnl_positions WHERE wallet_id = ? AND coin_mint = ? AND trade_uuid = ?'
    )
    .get(walletId, coinMint, tradeUuid);

  expect(Number(pnlPosition.total_tokens_bought)).toBeCloseTo(15, 6);
  expect(Number(pnlPosition.total_tokens_sold)).toBeCloseTo(8, 6);
  expect(Number(pnlPosition.total_sol_spent)).toBeCloseTo(2, 6);
  expect(Number(pnlPosition.total_sol_received)).toBeCloseTo(1.6, 6);
  expect(Number(pnlPosition.avg_cost_sol)).toBeCloseTo(2 / 15, 6);
  expect(Number(pnlPosition.avg_cost_usd)).toBeCloseTo(16, 6);
  expect(Number(pnlPosition.realized_sol)).toBeCloseTo(1.6 - (8 * (2 / 15)), 6);
  expect(Number(pnlPosition.realized_usd)).toBeCloseTo((1.6 - (8 * (2 / 15))) * 130, 6);
  expect(pnlPosition.first_trade_at).toBe(1000);
  expect(pnlPosition.last_trade_at).toBe(3000);
});
