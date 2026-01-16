'use strict';

const { createIsolatedAdapter } = require('./helpers/sqliteTestUtils');

describe('sqlite sellops adapter', () => {
  test('inserts and reads sellops evaluations', () => {
    const { adapter } = createIsolatedAdapter();
    const sellops = adapter.modules.sellops;

    const id = sellops.insertSellOpsEvaluation({
      walletId: 1,
      walletAlias: 'alpha',
      tradeUuid: 'trade-1',
      coinMint: 'MintA',
      recommendation: 'hold',
      decision: 'hold',
      tsMs: 123,
      reasons: ['rule'],
      payload: { ok: true },
    });

    expect(id).toBeGreaterThan(0);

    const latest = sellops.getLatestSellOpsEvaluationByTrade(1, 'trade-1');
    expect(latest).toEqual(expect.objectContaining({
      walletAlias: 'alpha',
      tradeUuid: 'trade-1',
      coinMint: 'MintA',
    }));

    const list = sellops.listSellOpsEvaluationsByTrade(1, 'trade-1', { limit: 10 });
    expect(list).toHaveLength(1);
  });

  test('requires core fields', () => {
    const { adapter } = createIsolatedAdapter();
    const sellops = adapter.modules.sellops;

    expect(() => sellops.insertSellOpsEvaluation({
      walletId: null,
      walletAlias: null,
      tradeUuid: null,
      coinMint: null,
      recommendation: null,
      decision: null,
    })).toThrow('insertSellOpsEvaluation: walletId, walletAlias, tradeUuid, and coinMint are required.');
  });
});
