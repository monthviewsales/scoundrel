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

describe('wallets submodule', () => {
  test('creates, lists, and sets default funding wallet', () => {
    const inserted = adapter.insertWarchestWallet({
      alias: 'main',
      pubkey: 'pub-main',
      usageType: 'funding',
      isDefaultFunding: false,
      autoAttachWarchest: true,
    });

    expect(inserted.alias).toBe('main');
    expect(adapter.listWarchestWallets()).toHaveLength(1);
    expect(adapter.getDefaultFundingWallet()).toBeNull();

    const updated = adapter.setDefaultFundingWallet('main');
    expect(updated.isDefaultFunding).toBe(true);
    expect(adapter.listFundingWallets()[0].alias).toBe('main');
  });

  test('updates wallet options and enforces a single default', () => {
    adapter.insertWarchestWallet({
      alias: 'primary',
      pubkey: 'pub-primary',
      usageType: 'funding',
      isDefaultFunding: true,
      autoAttachWarchest: false,
    });

    adapter.insertWarchestWallet({
      alias: 'secondary',
      pubkey: 'pub-secondary',
      usageType: 'other',
      isDefaultFunding: false,
      autoAttachWarchest: false,
    });

    const updated = adapter.updateWarchestWalletOptions('secondary', {
      usageType: 'strategy',
      autoAttachWarchest: true,
      isDefaultFunding: true,
      strategy: 'strat-1',
      color: '#abcdef',
    });

    expect(updated).toMatchObject({
      alias: 'secondary',
      usageType: 'strategy',
      autoAttachWarchest: true,
      isDefaultFunding: true,
      strategy: 'strat-1',
      color: '#abcdef',
    });

    const priorDefault = adapter.getWarchestWalletByAlias('primary');
    expect(priorDefault.isDefaultFunding).toBe(false);
    expect(adapter.getDefaultFundingWallet().alias).toBe('secondary');
  });

  test('upserts tracked KOL wallet from dossier data', () => {
    const walletId = adapter.upsertKolWalletFromDossier({
      wallet: 'wallet-1234',
      traderName: 'Trader',
      color: '#ff00ff',
    });
    expect(walletId).toBeTruthy();

    const kolList = adapter.listTrackedKolWallets();
    expect(kolList).toHaveLength(1);
    expect(kolList[0].alias).toContain('Trader');
  });
});

describe('profiles submodule', () => {
  test('records analyses and autopsies for wallets', () => {
    adapter.recordWalletAnalysis({
      analysisId: 'analysis-1',
      wallet: 'wallet-abc',
      traderName: 'Analyst',
      tradeCount: 2,
      chartCount: 1,
    });

    adapter.recordTradeAutopsy({
      autopsyId: 'autopsy-1',
      wallet: 'wallet-abc',
      mint: 'mint-xyz',
      symbol: 'XYZ',
    });

    const analyses = adapter.listWalletAnalysesByWallet('wallet-abc');
    expect(analyses).toHaveLength(1);
    expect(analyses[0].trader_name).toBe('Analyst');

    const autopsies = adapter.listTradeAutopsiesByWallet('wallet-abc');
    expect(autopsies).toHaveLength(1);
    expect(autopsies[0].symbol).toBe('XYZ');
  });

  test('lists asks by correlation id in chronological order', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000);

    adapter.recordAsk({
      askId: 'ask-1',
      correlationId: 'session-1',
      question: 'Q1',
      answer: 'A1',
      bullets: ['b1'],
      actions: [],
    });

    adapter.recordAsk({
      askId: 'ask-2',
      correlationId: 'session-1',
      question: 'Q2',
      answer: 'A2',
      bullets: [],
      actions: ['a2'],
    });

    adapter.recordAsk({
      askId: 'ask-3',
      correlationId: 'session-2',
      question: 'Q3',
      answer: 'A3',
    });

    const rows = adapter.listAsksByCorrelationId({ correlationId: 'session-1', limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0].question).toBe('Q1');
    expect(rows[1].question).toBe('Q2');
    expect(rows[0].bullets).toEqual(['b1']);
    expect(rows[1].actions).toEqual(['a2']);

    nowSpy.mockRestore();
  });
});

describe('targets submodule', () => {
  test('adds, fetches, and removes targets by mint', () => {
    const inserted = adapter.addUpdateTarget({
      mint: 'mint-abc',
      symbol: 'ABC',
      name: 'Alpha Beta Coin',
      status: 'watch',
      strategy: 'flash',
      strategyId: 'flash-1',
      source: 'target-list',
      tags: 'pumpfun,volume',
      notes: 'initial pass',
      vectorStoreId: 'vs-1',
      vectorStoreFileId: 'file-1',
      vectorStoreUpdatedAt: 1234,
      confidence: 0.72,
      score: 0.31,
      mintVerified: true,
      lastCheckedAt: Date.now(),
    });

    expect(inserted.mint).toBe('mint-abc');
    expect(inserted.status).toBe('watch');
    expect(inserted.strategy).toBe('flash');

    const fetched = adapter.getTarget('mint-abc');
    expect(fetched).toBeTruthy();
    expect(fetched.symbol).toBe('ABC');
    expect(fetched.status).toBe('watch');
    expect(fetched.vector_store_id).toBe('vs-1');
    expect(fetched.vector_store_file_id).toBe('file-1');

    const removed = adapter.removeTarget('mint-abc');
    expect(removed).toBe(1);
    expect(adapter.getTarget('mint-abc')).toBeNull();
  });

  test('updates vector store fields for targets', () => {
    adapter.addUpdateTarget({
      mint: 'mint-vs',
      status: 'new',
    });

    const updated = adapter.updateTargetVectorStore('mint-vs', {
      vectorStoreId: 'vs-2',
      vectorStoreFileId: 'file-2',
      vectorStoreUpdatedAt: 4242,
    });

    expect(updated.vector_store_id).toBe('vs-2');
    expect(updated.vector_store_file_id).toBe('file-2');
    expect(updated.vector_store_updated_at).toBe(4242);
  });

  test('prunes targets by status and last_checked_at', () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000 - 1000;
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    adapter.addUpdateTarget({
      mint: 'mint-approved',
      status: 'approved',
      lastCheckedAt: eightDaysAgo,
    });
    adapter.addUpdateTarget({
      mint: 'mint-archived-stale',
      status: 'archived',
      lastCheckedAt: eightDaysAgo,
    });
    adapter.addUpdateTarget({
      mint: 'mint-archived-fresh',
      status: 'archived',
      lastCheckedAt: now,
    });
    adapter.addUpdateTarget({
      mint: 'mint-rejected',
      status: 'rejected',
      lastCheckedAt: now,
    });
    adapter.addUpdateTarget({
      mint: 'mint-stale',
      status: 'watching',
      lastCheckedAt: twoHoursAgo,
    });
    adapter.addUpdateTarget({
      mint: 'mint-fresh',
      status: 'new',
      lastCheckedAt: now,
    });

    const prunable = adapter.listPrunableTargets({
      now,
      staleMs: 2 * 60 * 60 * 1000,
      archivedTtlMs: 7 * 24 * 60 * 60 * 1000,
    });

    const pruned = adapter.pruneTargets({
      now,
      staleMs: 2 * 60 * 60 * 1000,
      archivedTtlMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(prunable).toHaveLength(3);
    expect(pruned).toBe(3);
    expect(adapter.getTarget('mint-approved')).toBeTruthy();
    expect(adapter.getTarget('mint-archived-fresh')).toBeTruthy();
    expect(adapter.getTarget('mint-fresh')).toBeTruthy();
    expect(adapter.getTarget('mint-archived-stale')).toBeNull();
    expect(adapter.getTarget('mint-rejected')).toBeNull();
    expect(adapter.getTarget('mint-stale')).toBeNull();
  });

  test('lists targets by priority with watch lowest', () => {
    adapter.addUpdateTarget({ mint: 'mint-strong', status: 'strong_buy', score: 80, confidence: 0.9 });
    adapter.addUpdateTarget({ mint: 'mint-buy', status: 'buy', score: 80, confidence: 0.9 });
    adapter.addUpdateTarget({ mint: 'mint-watch', status: 'watch', score: 80, confidence: 0.9 });

    const list = adapter.listTargetsByPriority({ statuses: ['strong_buy', 'buy', 'watch'] });
    expect(list.map((row) => row.mint)).toEqual(['mint-strong', 'mint-buy', 'mint-watch']);
  });
});

describe('evaluations submodule', () => {
  test('inserts and fetches a buyOps evaluation', () => {
    const insertedId = adapter.insertEvaluation({
      opsType: 'buyOps',
      tsMs: Date.now(),
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: 'mint-buy',
      recommendation: 'hold',
      decision: 'buy',
      reasons: ['status:buy'],
      payload: { note: 'buy-eval' },
    });

    expect(insertedId).toBeTruthy();

    const latest = adapter.getLatestBuyOpsEvaluationByMint('mint-buy');
    expect(latest).toMatchObject({
      opsType: 'buyOps',
      walletAlias: 'alpha',
      coinMint: 'mint-buy',
      decision: 'buy',
    });
    expect(latest.payload).toEqual({ note: 'buy-eval' });
  });

  test('hydrates trailing state from sellOps evaluations', () => {
    adapter.insertSellOpsEvaluation({
      tsMs: Date.now(),
      walletId: 2,
      walletAlias: 'beta',
      tradeUuid: 'trade-123',
      coinMint: 'mint-sell',
      recommendation: 'hold',
      decision: 'hold',
      reasons: [],
      payload: {
        riskControls: {
          trailing: {
            active: true,
            highWaterUsd: 1.23,
          },
        },
      },
    });

    const ctx = adapter.getLatestSellOpsDecisionContextByTrade(2, 'trade-123');
    expect(ctx).toBeTruthy();
    expect(ctx.trailing).toMatchObject({ active: true, highWaterUsd: 1.23 });
  });
});

describe('coins submodule', () => {
  test('adds and retrieves coin metadata', () => {
    adapter.addOrUpdateCoin({
      mint: 'mint-1',
      symbol: 'TST',
      name: 'Test Coin',
      status: 'complete',
      buyScore: 5,
      priceUsd: 1.25,
      liquidityUsd: 10,
      marketCapUsd: 1000,
    });

    expect(adapter.getCoinCount()).toBe(1);
    const coin = adapter.getCoinByMint('mint-1');
    expect(coin.symbol).toBe('TST');

    adapter.updateCoinStatus('mint-1', 'blacklist');
    expect(adapter.getCoinStatus('mint-1')).toBe('blacklist');
  });
});

describe('coin metadata submodule', () => {
  test('upserts and retrieves coin metadata by mint', () => {
    const first = adapter.upsertCoinMetadata({
      metadataId: 'meta-1',
      mint: 'mint-meta',
      source: 'devscan',
      response: { source: 'devscan', score: 7 },
    });

    expect(first.mint).toBe('mint-meta');
    expect(first.source).toBe('devscan');
    expect(first.response_json).toBe(JSON.stringify({ source: 'devscan', score: 7 }));

    const second = adapter.upsertCoinMetadata({
      metadataId: 'meta-2',
      mint: 'mint-meta',
      source: 'partner',
      response: { source: 'partner', score: 4 },
    });

    expect(second.source).toBe('partner');

    const updated = adapter.upsertCoinMetadata({
      metadataId: 'meta-3',
      mint: 'mint-meta',
      source: 'devscan',
      response: { source: 'devscan', score: 9 },
    });

    const count = context.db
      .prepare('SELECT COUNT(*) as count FROM sc_coin_metadata WHERE mint = ?')
      .get('mint-meta').count;

    expect(count).toBe(2);
    expect(updated.metadata_id).toBe('meta-1');
    expect(updated.response_json).toBe(JSON.stringify({ source: 'devscan', score: 9 }));
  });
});

describe('trading submodule', () => {
  test('manages trade UUID cache and pending swaps', () => {
    adapter.setTradeUuid('mint-trade', 'uuid-123');
    expect(adapter.getTradeUuid('mint-trade')).toBe('uuid-123');

    adapter.clearTradeUuid('mint-trade');
    expect(adapter.getTradeUuid('mint-trade')).toBeNull();

    adapter.markPendingSwap('mint-trade');
    expect(adapter.getPendingSwapCount()).toBe(1);
    expect(adapter.isSwapPending('mint-trade')).toBe(true);
    adapter.markPendingSwap('mint-trade', 'wallet-a');
    expect(adapter.isSwapPending('mint-trade', 'wallet-a')).toBe(true);
    expect(adapter.getPendingSwapCount()).toBe(2);
    expect(adapter.isSwapPending('mint-trade', 'wallet-b')).toBe(false);
    adapter.clearPendingSwap('mint-trade');
    expect(adapter.isSwapPending('mint-trade')).toBe(false);
    expect(adapter.getPendingSwapCount()).toBe(1);
    adapter.clearPendingSwap('mint-trade', 'wallet-a');
    expect(adapter.getPendingSwapCount()).toBe(0);
  });

  test('recordScTradeEvent preserves swap pricing data when duplicates omit fields', () => {
    const txid = 'tx123';
    const walletId = 42;
    const baseEvent = {
      txid,
      walletId,
      walletAlias: 'primary',
      coinMint: 'mint-xyz',
      side: 'buy',
      executedAt: Date.now(),
      tokenAmount: 1000,
      solAmount: -0.25,
      tradeUuid: 'trade-1',
      strategyId: 'strat-1',
      strategyName: 'Strat One',
      priceSolPerToken: 0.00025,
      priceUsdPerToken: 0.05,
      solUsdPrice: 200,
      feesSol: 0.0005,
      feesUsd: 0.1,
      slippagePct: 0.5,
      priceImpactPct: 0.2,
      program: 'swapEngine',
      evaluationPayload: { foo: 'bar' },
      decisionPayload: { bar: 'baz' },
      decisionLabel: 'buy',
      decisionReason: 'quote_approved',
    };

    adapter.recordScTradeEvent(baseEvent);
    let row = context.db.prepare('SELECT * FROM sc_trades WHERE txid = ?').get(txid);

    expect(row.price_sol_per_token).toBeCloseTo(baseEvent.priceSolPerToken);
    expect(row.price_usd_per_token).toBeCloseTo(baseEvent.priceUsdPerToken);
    expect(row.sol_usd_price).toBeCloseTo(baseEvent.solUsdPrice);
    expect(row.fees_usd).toBeCloseTo(baseEvent.feesUsd);
    expect(row.wallet_alias).toBe('primary');

    adapter.recordScTradeEvent({
      txid,
      walletId,
      coinMint: 'mint-xyz',
      side: 'buy',
      executedAt: baseEvent.executedAt + 1000,
      tokenAmount: 1000,
      solAmount: -0.25,
      tradeUuid: null,
      strategyId: null,
      strategyName: null,
      priceSolPerToken: null,
      priceUsdPerToken: null,
      solUsdPrice: null,
      feesSol: null,
      feesUsd: null,
      slippagePct: null,
      priceImpactPct: null,
      program: null,
      evaluationPayload: null,
      decisionPayload: null,
      decisionLabel: null,
      decisionReason: null,
    });

    row = context.db.prepare('SELECT * FROM sc_trades WHERE txid = ?').get(txid);
    expect(row.price_sol_per_token).toBeCloseTo(baseEvent.priceSolPerToken);
    expect(row.price_usd_per_token).toBeCloseTo(baseEvent.priceUsdPerToken);
    expect(row.sol_usd_price).toBeCloseTo(baseEvent.solUsdPrice);
    expect(row.fees_usd).toBeCloseTo(baseEvent.feesUsd);
    expect(row.wallet_alias).toBe('primary');
    expect(row.decision_label).toBe('buy');
    expect(row.decision_reason).toBe('quote_approved');
  });

  test('recordScTradeEvent inserts buy then sell with shared trade_uuid and closes position', () => {
    const mint = 'Gbz4HzY4KunK96e8dART7GhbV4bEjYSUXEA2cy2qpump';
    const walletId = 1;
    const baseExecutedAt = Date.UTC(2025, 0, 1);

    const buyTrade = {
      txid: 'buy-tx-sample',
      walletId,
      walletAlias: 'warlord',
      coinMint: mint,
      side: 'buy',
      executedAt: baseExecutedAt,
      tokenAmount: 7041.856537851523,
      solAmount: -0.01,
      priceSolPerToken: 0.0000013774776506536839,
      priceUsdPerToken: 0.00018267840275627408,
      solUsdPrice: 132.64,
      feesSol: 0.000005,
      slippagePct: 20,
      priceImpactPct: 0.01,
      program: 'swapEngine',
      decisionPayload: { swapQuote: { foo: 'bar' } },
    };

    expect(() => adapter.recordScTradeEvent(buyTrade)).not.toThrow();

    const buyRow = context.db.prepare('SELECT * FROM sc_trades WHERE txid = ?').get(buyTrade.txid);
    expect(buyRow).toBeTruthy();
    expect(buyRow.trade_uuid).toBeTruthy();
    expect(buyRow.side).toBe('buy');
    expect(buyRow.coin_mint).toBe(mint);

    const positionAfterBuy = context.db
      .prepare('SELECT * FROM sc_positions WHERE wallet_id = ? AND coin_mint = ?')
      .get(walletId, mint);
    expect(positionAfterBuy.trade_uuid).toBe(buyRow.trade_uuid);
    expect(positionAfterBuy.current_token_amount).toBeCloseTo(buyTrade.tokenAmount, 6);
    expect(positionAfterBuy.closed_at).toBe(0);

    const sellTrade = {
      txid: 'sell-tx-sample',
      walletId,
      walletAlias: 'warlord',
      coinMint: mint,
      side: 'sell',
      executedAt: baseExecutedAt + 60_000,
      tokenAmount: buyTrade.tokenAmount,
      solAmount: 0.009357765395460339,
      priceSolPerToken: 0.000001329,
      priceUsdPerToken: 0.00018166965056324195,
      solUsdPrice: 136.71,
      feesSol: 0.000005,
      slippagePct: 20,
      priceImpactPct: 0.01,
      program: 'swapEngine',
    };

    expect(() => adapter.recordScTradeEvent(sellTrade)).not.toThrow();

    const sellRow = context.db.prepare('SELECT * FROM sc_trades WHERE txid = ?').get(sellTrade.txid);
    expect(sellRow).toBeTruthy();
    expect(sellRow.trade_uuid).toBe(buyRow.trade_uuid);
    expect(sellRow.side).toBe('sell');

    const positionAfterSell = context.db
      .prepare('SELECT * FROM sc_positions WHERE wallet_id = ? AND coin_mint = ?')
      .get(walletId, mint);

    expect(positionAfterSell.trade_uuid).toBe(buyRow.trade_uuid);
    const remainingTokens = Math.abs(positionAfterSell.current_token_amount);
    expect(remainingTokens).toBeLessThan(1e-6);
    expect(positionAfterSell.closed_at).toBeGreaterThan(0);
    expect(positionAfterSell.last_trade_at).toBe(sellTrade.executedAt);
  });

  test('loadOpenPositions returns only open, non-zero positions for a wallet alias', () => {
    const now = Date.now();

    adapter.ensureOpenPositionRun({
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: 'mint-open',
      currentTokenAmount: 25,
      openAt: now,
    });

    adapter.ensureOpenPositionRun({
      walletId: 2,
      walletAlias: 'beta',
      coinMint: 'mint-other',
      currentTokenAmount: 30,
      openAt: now,
    });

    const closed = adapter.ensureOpenPositionRun({
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: 'mint-closed',
      currentTokenAmount: 10,
      openAt: now,
    }).position;

    context.db.prepare('UPDATE sc_positions SET closed_at = ? WHERE position_id = ?').run(now, closed.position_id);

    const empty = adapter.ensureOpenPositionRun({
      walletId: 1,
      walletAlias: 'alpha',
      coinMint: 'mint-empty',
      currentTokenAmount: 0,
      openAt: now,
    }).position;

    context.db.prepare('UPDATE sc_positions SET current_token_amount = 0 WHERE position_id = ?').run(
      empty.position_id
    );

    const { rows } = adapter.loadOpenPositions('alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0].coin_mint).toBe('mint-open');
    expect(rows[0].wallet_alias).toBe('alpha');
  });
});
