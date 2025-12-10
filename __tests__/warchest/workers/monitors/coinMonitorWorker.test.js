'use strict';

const { createCoinMonitorController } = require('../../../../lib/warchest/workers/coinMonitorWorker');

describe('coinMonitorWorker controller', () => {
  test('stops on explicit request and cleans up subscriptions', async () => {
    const unsubscribeAccount = jest.fn();
    const unsubscribeLogs = jest.fn();
    const rpcMethods = {
      getTokenAccountsByOwner: jest.fn().mockResolvedValue({
        value: [
          {
            pubkey: 'acct1',
            account: {
              data: { parsed: { info: { tokenAmount: { uiAmount: 5, decimals: 6 } } } },
            },
          },
        ],
      }),
      subscribeAccount: jest.fn(async (_addr, onUpdate) => {
        onUpdate({ value: { data: { parsed: { info: { tokenAmount: { uiAmount: 5, decimals: 6 } } } } } });
        return { unsubscribe: unsubscribeAccount };
      }),
      subscribeLogs: jest.fn(async () => ({ unsubscribe: unsubscribeLogs })),
    };
    const track = jest.fn();
    const snapshot = jest.fn();

    const controller = createCoinMonitorController(
      { mint: 'Mint111', wallet: { alias: 'alpha', pubkey: 'WalletPub' }, renderIntervalMs: 25 },
      { rpcMethods, track, writeStatusSnapshot: snapshot }
    );

    const resultPromise = controller.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(rpcMethods.subscribeAccount).toHaveBeenCalled();
    await controller.stop('manual');
    const result = await resultPromise;

    expect(result.status).toBe('stopped');
    expect(result.stopReason).toBe('manual');
    expect(unsubscribeAccount).toHaveBeenCalled();
    expect(unsubscribeLogs).toHaveBeenCalled();
    expect(track).toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'manual', balance: expect.any(Number) })
    );
  });

  test('exits when balance drains to zero', async () => {
    const unsubscribeAccount = jest.fn();
    let onAccountUpdate = null;
    const rpcMethods = {
      getTokenAccountsByOwner: jest.fn().mockResolvedValue({
        value: [
          {
            pubkey: 'acct1',
            account: {
              data: { parsed: { info: { tokenAmount: { uiAmount: 2, decimals: 6 } } } },
            },
          },
        ],
      }),
      subscribeAccount: jest.fn(async (_addr, onUpdate) => {
        onAccountUpdate = onUpdate;
        return { unsubscribe: unsubscribeAccount };
      }),
    };
    const snapshot = jest.fn();

    const controller = createCoinMonitorController(
      { mint: 'Mint222', wallet: { alias: 'beta', pubkey: 'WalletPub' } },
      { rpcMethods, writeStatusSnapshot: snapshot }
    );

    const resultPromise = controller.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(typeof onAccountUpdate).toBe('function');
    onAccountUpdate({ value: { data: { parsed: { info: { tokenAmount: { uiAmount: 0, decimals: 6 } } } } } });

    const result = await resultPromise;

    expect(result.status).toBe('drained');
    expect(result.finalBalance).toBe(0);
    expect(unsubscribeAccount).toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'drained' }));
  });
});
