'use strict';

const fs = require('fs');
const { createIsolatedAdapter } = require('./helpers/sqliteTestUtils');

describe('sc_positions USD fallback', () => {
  let adapter;
  let context;
  let tmpDir;

  beforeAll(async () => {
    ({ adapter, context, tmpDir } = createIsolatedAdapter());
    if (adapter && typeof adapter.init === 'function') {
      await adapter.init();
    }
  });

  afterAll(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('uses priceUsdPerToken when solUsdPrice is missing', () => {
    const trade = {
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: 'mint-1',
      txid: 'tx-1',
      side: 'buy',
      tokenAmount: 100,
      solAmount: 0,
      priceUsdPerToken: 0.42,
      executedAt: Date.now(),
    };

    adapter.recordScTradeEvent(trade);

    const row = context.db.prepare(
      'SELECT entry_price_usd FROM sc_positions WHERE wallet_id = ? AND coin_mint = ?'
    ).get(1, 'mint-1');

    expect(row).toBeTruthy();
    expect(row.entry_price_usd).toBeCloseTo(0.42);
  });
});
