'use strict';

const { createIsolatedAdapter } = require('./helpers/sqliteTestUtils');

describe('sqlite buyops adapter', () => {
  test('inserts and reads buyops evaluations', () => {
    const { adapter } = createIsolatedAdapter();
    const buyops = adapter.modules.buyops;

    const id = buyops.insertBuyOpsEvaluation({
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: 'MintA',
      recommendation: 'hold',
      decision: 'buy',
      tsMs: 123,
      reasons: ['rule'],
      payload: { ok: true },
    });

    expect(id).toBeGreaterThan(0);

    const latest = buyops.getLatestBuyOpsEvaluationByMint('MintA');
    expect(latest).toEqual(expect.objectContaining({
      walletAlias: 'alpha',
      coinMint: 'MintA',
    }));

    const list = buyops.listBuyOpsEvaluationsByMint('MintA', { limit: 10 });
    expect(list).toHaveLength(1);
  });

  test('requires core fields', () => {
    const { adapter } = createIsolatedAdapter();
    const buyops = adapter.modules.buyops;

    expect(() => buyops.insertBuyOpsEvaluation({
      walletId: null,
      walletAlias: null,
      coinMint: null,
      recommendation: null,
      decision: null,
    })).toThrow('insertBuyOpsEvaluation: walletId, walletAlias, and coinMint are required.');
  });
});
