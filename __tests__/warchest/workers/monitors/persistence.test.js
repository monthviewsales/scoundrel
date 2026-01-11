'use strict';

const { createMonitorPersistence } = require('../../../../lib/warchest/workers/monitors/persistence');

describe('monitor persistence', () => {
  test('snapshot writes status payloads', () => {
    const writeStatusSnapshot = jest.fn();
    const { snapshot } = createMonitorPersistence({
      writeStatusSnapshot,
      mint: 'MintA',
      walletAlias: 'alpha',
    });

    snapshot({
      stopReason: 'done',
      balance: 1.23,
      accounts: [{ pubkey: 'Wallet1' }],
    });

    expect(writeStatusSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      component: 'coinMonitor',
      mint: 'MintA',
      walletAlias: 'alpha',
      stopReason: 'done',
    }));
  });
});
