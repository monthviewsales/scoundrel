'use strict';

jest.mock('../../db', () => ({
  getPnlPositionsLive: jest.fn(),
}));

jest.mock('../../lib/warchest/workers/workerLogger', () => ({
  createWorkerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({})),
}));

jest.mock('../../lib/services/txInsightService', () => ({}));

jest.mock('../../lib/solana/rpcMethods/internal/walletState', () => ({
  updateSol: jest.fn(),
}));

jest.mock('../../lib/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => logger),
  };
  return {
    ...logger,
    solanaTrackerData: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  };
});

describe('refreshPnlPositionsForWallet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('keeps rows that only provide currentTokenAmount', async () => {
    const BootyBox = require('../../db');
    BootyBox.getPnlPositionsLive.mockResolvedValue([
      {
        coin_mint: 'mint1',
        currentTokenAmount: '12.5',
        avg_cost_usd: 1,
        coin_price_usd: 2,
      },
    ]);

    const { refreshPnlPositionsForWallet } = require('../../lib/warchest/workers/warchestService');

    const wallet = { walletId: 7, alias: 'alpha' };
    await refreshPnlPositionsForWallet(wallet);

    expect(BootyBox.getPnlPositionsLive).toHaveBeenCalledWith({ walletId: 7 });
    expect(wallet.pnlByMint).toHaveProperty('mint1');
    expect(wallet.pnlByMint.mint1.current_token_amount).toBeCloseTo(12.5);
    expect(wallet.pnlByMint.mint1.currentTokenAmount).toBeCloseTo(12.5);
  });

  test('filters out empty positions and missing mints', async () => {
    const BootyBox = require('../../db');
    BootyBox.getPnlPositionsLive.mockResolvedValue([
      { coin_mint: 'mint1', current_token_amount: 0 },
      { coin_mint: 'mint2', currentTokenAmount: '5' },
      { mint: 'mint3', currentTokenAmount: -1 },
      { coinMint: 'mint4', currentTokenAmount: 2 },
      { currentTokenAmount: 3 },
    ]);

    const { refreshPnlPositionsForWallet } = require('../../lib/warchest/workers/warchestService');

    const wallet = { walletId: 7, alias: 'alpha' };
    await refreshPnlPositionsForWallet(wallet);

    expect(Object.keys(wallet.pnlByMint)).toEqual(['mint2', 'mint4']);
  });

  test('logs and returns on fetch errors', async () => {
    const BootyBox = require('../../db');
    BootyBox.getPnlPositionsLive.mockRejectedValue(new Error('boom'));

    const { refreshPnlPositionsForWallet } = require('../../lib/warchest/workers/warchestService');

    const wallet = { walletId: 7, alias: 'alpha', pnlByMint: { existing: true } };
    await refreshPnlPositionsForWallet(wallet);

    expect(wallet.pnlByMint).toEqual({ existing: true });
  });
});

describe('HUD state helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('buildInitialState seeds wallet state', () => {
    const { buildInitialState } = require('../../lib/warchest/workers/warchestService');
    const state = buildInitialState([
      { alias: 'alpha', pubkey: 'pub1', color: 'red', walletId: 1 },
      { alias: 'beta', pubkey: 'pub2', color: null, walletId: 2 },
    ]);

    expect(Object.keys(state)).toEqual(['alpha', 'beta']);
    expect(state.alpha.pubkey).toBe('pub1');
    expect(state.alpha.startSolBalance).toBeNull();
    expect(Array.isArray(state.beta.tokens)).toBe(true);
  });

  test('pushRecentEvent caps log length and emits change', () => {
    const { pushRecentEvent } = require('../../lib/warchest/workers/warchestService');
    const wallet = {
      recentEvents: Array.from({ length: 5 }, (_, idx) => ({ ts: idx, summary: `old-${idx}` })),
    };
    const hudStore = { emitChange: jest.fn() };

    pushRecentEvent(wallet, 'new event', hudStore);

    expect(wallet.recentEvents).toHaveLength(5);
    expect(wallet.recentEvents[0].summary).toBe('new event');
    expect(hudStore.emitChange).toHaveBeenCalled();
  });

  test('fetchSolBalance returns balance and handles errors', async () => {
    const { fetchSolBalance } = require('../../lib/warchest/workers/warchestService');
    const okRpc = { getSolBalance: jest.fn().mockResolvedValue(2.5) };
    const badRpc = { getSolBalance: jest.fn().mockRejectedValue(new Error('boom')) };

    await expect(fetchSolBalance(okRpc, 'pub')).resolves.toBe(2.5);
    await expect(fetchSolBalance(badRpc, 'pub')).resolves.toBeNull();
  });

  test('refreshAllSolBalances updates state and syncs walletState', async () => {
    const { refreshAllSolBalances } = require('../../lib/warchest/workers/warchestService');
    const { updateSol } = require('../../lib/solana/rpcMethods/internal/walletState');
    const rpcMethods = {
      getSolBalance: jest.fn()
        .mockResolvedValueOnce(1.5)
        .mockResolvedValueOnce(3.0),
    };
    const state = {
      alpha: { alias: 'alpha', pubkey: 'pub1', startSolBalance: null, solBalance: 0 },
      beta: { alias: 'beta', pubkey: 'pub2', startSolBalance: 2, solBalance: 2 },
    };
    const hudStore = { emitChange: jest.fn() };

    await refreshAllSolBalances(rpcMethods, state, hudStore);

    expect(state.alpha.solBalance).toBe(1.5);
    expect(state.alpha.solSessionDelta).toBe(0);
    expect(state.beta.solBalance).toBe(3.0);
    expect(state.beta.solSessionDelta).toBe(1.0);
    expect(updateSol).toHaveBeenCalledWith('pub1', 1500000000);
    expect(updateSol).toHaveBeenCalledWith('pub2', 3000000000);
    expect(hudStore.emitChange).toHaveBeenCalled();
  });

  test('refreshPnlPositions iterates wallets and emits change', async () => {
    const BootyBox = require('../../db');
    BootyBox.getPnlPositionsLive.mockResolvedValue([
      { coin_mint: 'mint1', current_token_amount: 1 },
    ]);
    const { refreshPnlPositions } = require('../../lib/warchest/workers/warchestService');
    const state = {
      alpha: { walletId: 1, alias: 'alpha' },
      beta: { walletId: 2, alias: 'beta' },
    };
    const hudStore = { emitChange: jest.fn() };

    await refreshPnlPositions(state, hudStore);

    expect(BootyBox.getPnlPositionsLive).toHaveBeenCalledTimes(2);
    expect(hudStore.emitChange).toHaveBeenCalled();
  });
});

describe('createWalletTokenRefreshScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('debounces and queues refreshes without overlap', async () => {
    process.env.WARCHEST_LOG_REFRESH_DEBOUNCE_MS = '5';
    jest.useFakeTimers();

    const deferred = () => {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    const firstBalances = deferred();
    const firstPnl = deferred();
    const secondBalances = deferred();
    const secondPnl = deferred();

    let createWalletTokenRefreshScheduler;
    jest.isolateModules(() => {
      ({ createWalletTokenRefreshScheduler } = require('../../lib/warchest/workers/warchestService'));
    });

    const refreshTokenBalances = jest
      .fn()
      .mockImplementationOnce(() => firstBalances.promise)
      .mockImplementationOnce(() => secondBalances.promise);
    const refreshPnlPositions = jest
      .fn()
      .mockImplementationOnce(() => firstPnl.promise)
      .mockImplementationOnce(() => secondPnl.promise);
    const emitHudChange = jest.fn();
    const getRpcMethods = jest.fn(() => ({}));
    const state = {
      alpha: { alias: 'alpha', pubkey: 'PUB', tokens: [] },
    };

    const schedule = createWalletTokenRefreshScheduler({
      state,
      getRpcMethods,
      emitHudChange,
      refreshTokenBalances,
      refreshPnlPositions,
    });

    schedule('alpha', 'log');
    schedule('alpha', 'log2');

    await jest.advanceTimersByTimeAsync(5);
    expect(refreshTokenBalances).toHaveBeenCalledTimes(1);
    expect(refreshPnlPositions).toHaveBeenCalledTimes(0);

    schedule('alpha', 'log3');

    firstBalances.resolve();
    firstPnl.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(5);
    secondBalances.resolve();
    secondPnl.resolve();
    await Promise.resolve();

    expect(refreshTokenBalances).toHaveBeenCalledTimes(2);
    expect(refreshPnlPositions).toHaveBeenCalledTimes(2);
    expect(emitHudChange).toHaveBeenCalled();

    jest.useRealTimers();
    delete process.env.WARCHEST_LOG_REFRESH_DEBOUNCE_MS;
  });

  test('skips unknown wallets', () => {
    const { createWalletTokenRefreshScheduler } = require('../../lib/warchest/workers/warchestService');
    const refreshTokenBalances = jest.fn();
    const refreshPnlPositions = jest.fn();
    const schedule = createWalletTokenRefreshScheduler({
      state: { alpha: { alias: 'alpha' } },
      getRpcMethods: jest.fn(),
      emitHudChange: jest.fn(),
      refreshTokenBalances,
      refreshPnlPositions,
    });

    schedule('missing', 'log');

    expect(refreshTokenBalances).not.toHaveBeenCalled();
    expect(refreshPnlPositions).not.toHaveBeenCalled();
  });

  test('continues after refresh errors', async () => {
    process.env.WARCHEST_LOG_REFRESH_DEBOUNCE_MS = '5';
    jest.useFakeTimers();

    let createWalletTokenRefreshScheduler;
    jest.isolateModules(() => {
      ({ createWalletTokenRefreshScheduler } = require('../../lib/warchest/workers/warchestService'));
    });

    const refreshTokenBalances = jest.fn().mockRejectedValue(new Error('refresh failed'));
    const refreshPnlPositions = jest.fn();
    const emitHudChange = jest.fn();
    const schedule = createWalletTokenRefreshScheduler({
      state: { alpha: { alias: 'alpha', pubkey: 'PUB' } },
      getRpcMethods: jest.fn(() => ({})),
      emitHudChange,
      refreshTokenBalances,
      refreshPnlPositions,
    });

    schedule('alpha', 'log');

    await jest.advanceTimersByTimeAsync(5);
    await Promise.resolve();

    expect(refreshTokenBalances).toHaveBeenCalledTimes(1);
    expect(refreshPnlPositions).not.toHaveBeenCalled();
    expect(emitHudChange).toHaveBeenCalled();

    jest.useRealTimers();
    delete process.env.WARCHEST_LOG_REFRESH_DEBOUNCE_MS;
  });
});

describe('pnl normalization helpers', () => {
  test('toNum normalizes numeric inputs', () => {
    const { toNum } = require('../../lib/warchest/workers/warchestService');
    expect(toNum(null)).toBeNull();
    expect(toNum('not-a-number')).toBeNull();
    expect(toNum(2)).toBe(2);
    expect(toNum(3n)).toBe(3);
    expect(toNum('4.5')).toBe(4.5);
  });

  test('normalizePnlRow computes derived values', () => {
    const { normalizePnlRow } = require('../../lib/warchest/workers/warchestService');
    const row = normalizePnlRow({
      coin_mint: 'mint1',
      currentTokenAmount: '2',
      avg_cost_usd: '1.5',
      coin_price_usd: '2.5',
    });

    expect(row.entry_usd).toBeCloseTo(3);
    expect(row.current_usd).toBeCloseTo(5);
    expect(row.unrealized_pnl_usd).toBeCloseTo(2);
    expect(row.roi_pct).toBeCloseTo(66.666, 2);
  });

  test('normalizePnlRow prefers provided values', () => {
    const { normalizePnlRow } = require('../../lib/warchest/workers/warchestService');
    const row = normalizePnlRow({
      coin_mint: 'mint2',
      current_token_amount: 2,
      entry_usd: 10,
      current_usd: 12,
      unrealized_usd: 1,
      realized_usd: 0.5,
    });

    expect(row.entry_usd).toBe(10);
    expect(row.current_usd).toBe(12);
    expect(row.unrealized_pnl_usd).toBe(1);
    expect(row.realized_pnl_usd).toBe(0.5);
  });
});

describe('warchestService utility helpers', () => {
  test('pushServiceAlert caps list length', () => {
    const { pushServiceAlert } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const alerts = Array.from({ length: 8 }, (_, idx) => ({ message: `old-${idx}` }));

    pushServiceAlert(alerts, 'warn', 'new message', { meta: true });

    expect(alerts).toHaveLength(8);
    expect(alerts[0].message).toBe('new message');
    expect(alerts[0].level).toBe('warn');
  });

  test('withTimeout resolves fast promises and rejects on timeout', async () => {
    const { withTimeout } = require('../../lib/warchest/workers/warchestServiceHelpers');
    await expect(withTimeout(Promise.resolve('ok'), 10, 'fast')).resolves.toBe('ok');

    jest.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 5, 'slow');
    const expectation = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await jest.advanceTimersByTimeAsync(5);
    await expectation;
    jest.useRealTimers();
  });

  test('parseArgs supports wallet specs and hud mode', () => {
    const { parseArgs } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const logger = { warn: jest.fn() };
    const result = parseArgs(['node', 'script', '--wallet', 'alpha:pub:blue', '--wallet', 'bad', '--hud'], logger);

    expect(result.mode).toBe('hud');
    expect(result.wallets).toEqual([{ alias: 'alpha', pubkey: 'pub', color: 'blue' }]);
  });

  test('extractPriceChange filters to valid slices', () => {
    const { extractPriceChange } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const result = extractPriceChange({
      '1m': { priceChangePercentage: '1.2' },
      '5m': { priceChangePercentage: 'nope' },
    });

    expect(result).toEqual({ '1m': 1.2 });
    expect(extractPriceChange(null)).toBeNull();
  });

  test('mapCoinMeta maps token info', () => {
    const { mapCoinMeta } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const result = mapCoinMeta({
      token: { mint: 'mint1', name: 'Token', symbol: 'TOK' },
      pools: [{ price: { usd: '1.5' }, lastUpdated: '123' }],
      events: { '1m': { priceChangePercentage: 2 } },
      holders: [{}, {}],
    });

    expect(result).toEqual(expect.objectContaining({
      mint: 'mint1',
      symbol: 'TOK',
      priceUsd: 1.5,
      holders: 2,
      lastUpdated: 123,
      events: { '1m': 2 },
    }));
  });

  test('pickPrimaryPool selects highest liquidity', () => {
    const { pickPrimaryPool } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const pools = [
      { id: 'a', liquidity: { usd: 1 } },
      { id: 'b', liquidityUsd: 5 },
      { id: 'c', liquidity: 3 },
    ];

    expect(pickPrimaryPool(pools)).toEqual(expect.objectContaining({ id: 'b' }));
  });

  test('extractCurvePct returns curve percentage when present', () => {
    const { extractCurvePct } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const pools = [{ curvePercentage: '10' }, { curvePercentage: 5 }];
    expect(extractCurvePct(pools)).toBe(10);
    expect(extractCurvePct([])).toBeNull();
  });

  test('extractRiskFields parses risk fields', () => {
    const { extractRiskFields } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const result = extractRiskFields({
      risk: {
        score: '7',
        top10: '12',
        snipers: { totalPercentage: '3.5' },
        dev: { percentage: 2 },
        risks: [{ name: 'honeypot' }, { name: '' }, null],
      },
    });

    expect(result).toEqual({
      riskScore: 7,
      top10Pct: 12,
      sniperPct: 3.5,
      devPct: 2,
      riskTags: ['honeypot'],
    });
  });

  test('deriveStatusCategory and emoji normalize statuses', () => {
    const { deriveStatusCategory, deriveStatusEmoji } = require('../../lib/warchest/workers/warchestServiceHelpers');
    expect(deriveStatusCategory({ status: 'confirmed' })).toBe('confirmed');
    expect(deriveStatusCategory({ status: 'failed' })).toBe('failed');
    expect(deriveStatusCategory({})).toBe('processed');
    expect(deriveStatusEmoji('confirmed')).toBe('🟢');
    expect(deriveStatusEmoji('failed')).toBe('🔴');
    expect(deriveStatusEmoji('other')).toBe('🟡');
  });

  test('buildTxDisplay merges current and previous fields', () => {
    const { buildTxDisplay } = require('../../lib/warchest/workers/warchestServiceHelpers');
    const prev = { txid: 'prev', mint: 'mint1', statusEmoji: 'old', tokens: 1 };
    const event = {
      txid: 'tx1',
      context: { side: 'buy', mint: 'mint1', wallet: 'wallet1' },
      txSummary: { statusCategory: 'confirmed', tokens: 2, blockTimeIso: '2024-01-01T00:00:00Z' },
    };

    const result = buildTxDisplay(event, prev);
    expect(result.txid).toBe('tx1');
    expect(result.statusCategory).toBe('confirmed');
    expect(result.side).toBe('buy');
    expect(result.tokens).toBe(2);
  });

  test('createThrottledEmitter throttles calls', async () => {
    const { createThrottledEmitter } = require('../../lib/warchest/workers/warchestServiceHelpers');
    jest.useFakeTimers();
    const emit = jest.fn();
    const throttled = createThrottledEmitter(emit, 10);

    throttled();
    throttled();
    expect(emit).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10);
    expect(emit).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
