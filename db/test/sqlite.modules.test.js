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
      strategyId: 'strat-1',
      color: '#abcdef',
    });

    expect(updated).toMatchObject({
      alias: 'secondary',
      usageType: 'strategy',
      autoAttachWarchest: true,
      isDefaultFunding: true,
      strategyId: 'strat-1',
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
});
