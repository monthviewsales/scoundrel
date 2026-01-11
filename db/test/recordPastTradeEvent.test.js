'use strict';

const { createIsolatedAdapter } = require('./helpers/sqliteTestUtils');

describe('recordPastTradeEvent', () => {
  test('records a past trade row', () => {
    const { adapter } = createIsolatedAdapter();
    const { recordPastTradeEvent } = adapter.modules.trading;

    const row = recordPastTradeEvent({
      wallet_id: 1,
      wallet_alias: 'alpha',
      coin_mint: 'MintA',
      side: 'buy',
      txid: 'tx-1',
      executed_at: 1_700_000_000,
      token_amount: 1.5,
      sol_amount: 0.1,
      price_usd_per_token: 0.02,
      source: 'backfill',
      note: 'test',
    });

    expect(row.txid).toBe('tx-1');
    expect(row.wallet_id).toBe(1);
    expect(row.executed_at).toBeGreaterThan(1_000_000_000_000);
  });

  test('requires a trade object', () => {
    const { adapter } = createIsolatedAdapter();
    const { recordPastTradeEvent } = adapter.modules.trading;

    expect(() => recordPastTradeEvent(null)).toThrow('recordPastTradeEvent(trade) requires a trade object');
  });
});
