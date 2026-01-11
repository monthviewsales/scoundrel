'use strict';

const { createSellOpsOrchestrator } = require('../../../../lib/warchest/workers/warchest/sellOpsOrchestrator');

describe('sellOpsOrchestrator', () => {
  test('tracks heartbeat and evaluation updates', async () => {
    const wallets = [{ alias: 'alpha', pubkey: 'Wallet1', color: 'blue' }];
    const state = {
      alpha: {
        tokens: [{ mint: 'MintA', symbol: 'MTA' }],
        events: [],
      },
    };
    const serviceAlerts = [];
    const hudStore = { emitChange: jest.fn() };
    const pushServiceAlert = jest.fn();
    const pushRecentEvent = jest.fn();
    const emitHudChange = jest.fn();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    let onProgress = null;
    const forkWorkerWithPayload = jest.fn((_path, opts) => {
      onProgress = opts.onProgress;
      return { stop: jest.fn() };
    });

    const orchestrator = createSellOpsOrchestrator({
      wallets,
      state,
      serviceAlerts,
      hudStore,
      forkWorkerWithPayload,
      pushServiceAlert,
      pushRecentEvent,
      emitHudChange,
      logger,
      hudMaxLogs: 5,
      dataEndpoint: null,
      pollIntervalMs: 1000,
      workerPath: '/tmp/sellops-worker.js',
    });

    await orchestrator.start();

    onProgress({
      type: 'sellOps:heartbeat',
      payload: { walletAlias: 'alpha', status: 'ok', openPositions: 1 },
    });

    onProgress({
      type: 'sellOps:evaluation',
      payload: {
        walletAlias: 'alpha',
        mint: 'MintA',
        recommendation: 'sell',
        strategy: { name: 'demo' },
        qualify: { failedCount: 1, worstSeverity: 'high' },
        regime: { status: 'risk' },
      },
    });

    const snapshot = orchestrator.getState();
    expect(snapshot.byWallet.alpha.heartbeat.status).toBe('ok');
    expect(snapshot.byWallet.alpha.evalByMint.MintA).toBeTruthy();
    expect(state.alpha.tokens[0].sellOpsLine).toContain('SellOps');
    expect(pushServiceAlert).toHaveBeenCalled();
    expect(pushRecentEvent).toHaveBeenCalled();
    expect(emitHudChange).toHaveBeenCalled();
  });
});
