'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCloseRpc = jest.fn().mockResolvedValue();
const mockResolveWalletSpecsWithRegistry = jest.fn(async (wallets) =>
  wallets.map((w, idx) => ({ ...w, walletId: idx + 1 })),
);

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../lib/solanaTrackerRPCClient', () => ({
  createSolanaTrackerRPCClient: jest.fn(() => ({
    rpc: { id: 'rpc' },
    rpcSubs: { id: 'subs' },
    close: mockCloseRpc,
  })),
}));

jest.mock('../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({ id: 'data-client' })),
}));

jest.mock('../../lib/solana/rpcMethods', () => ({
  createRpcMethods: jest.fn(() => ({ id: 'rpc-methods' })),
}));

jest.mock('../../lib/wallets/resolver', () => ({
  resolveWalletSpecsWithRegistry: mockResolveWalletSpecsWithRegistry,
}));

jest.mock('../../db', () => ({
  init: jest.fn().mockResolvedValue(),
  recordScTradeEvent: jest.fn(),
  applyScTradeEventToPositions: jest.fn(),
  getWarchestWalletByAlias: jest.fn(),
  insertWarchestWallet: jest.fn((spec) => ({ ...spec, walletId: 42 })),
  updateWarchestWalletColor: jest.fn(),
}));

describe('warchest client setup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('creates shared clients and cleans up tracked resources', async () => {
    await jest.isolateModulesAsync(async () => {
      const { setup } = require('../../lib/warchest/client');
      const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warchest-client-'));

      const client = await setup({
        walletSpecs: [{ alias: 'alpha', pubkey: 'PUB', color: 'green' }],
        mode: 'daemon',
        statusDir,
      });

      expect(client.state.alpha.pubkey).toBe('PUB');
        expect(mockResolveWalletSpecsWithRegistry).toHaveBeenCalled();

      const timer = setInterval(() => {}, 1000);
      const sub = { unsubscribe: jest.fn().mockResolvedValue() };
      client.trackInterval(timer);
      client.trackSubscription(sub);

      const writeSpy = jest.spyOn(fs, 'writeFileSync');
      const renameSpy = jest.spyOn(fs, 'renameSync');

      client.writeStatusSnapshot({ ok: true });

      const tempWriteCall = writeSpy.mock.calls.find(([target]) =>
        typeof target === 'string'
        && target.includes(`${path.sep}.status.json.`)
        && String(target).endsWith('.tmp'));
      expect(tempWriteCall).toBeTruthy();

      const tmpPath = tempWriteCall[0];
      const renameCall = renameSpy.mock.calls.find(([from]) => from === tmpPath);
      expect(renameCall).toBeTruthy();
      expect(renameCall[1]).toBe(path.join(statusDir, 'status.json'));

      await client.close();

      const snapshotPath = path.join(statusDir, 'status.json');
      expect(fs.existsSync(snapshotPath)).toBe(true);
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.health.ok).toBe(true);

      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(mockCloseRpc).toHaveBeenCalled();

      clearInterval(timer);
      fs.rmSync(statusDir, { recursive: true, force: true });
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });

  test('throws when BootyBox helpers are missing', async () => {
    jest.resetModules();
    jest.doMock('../../db', () => ({
      init: jest.fn().mockResolvedValue(),
      recordScTradeEvent: null,
      applyScTradeEventToPositions: null,
    }));
    jest.doMock('../../lib/solanaTrackerRPCClient', () => ({
      createSolanaTrackerRPCClient: jest.fn(() => ({ rpc: {}, rpcSubs: {}, close: jest.fn() })),
    }));
    jest.doMock('../../lib/solanaTrackerDataClient', () => ({
      createSolanaTrackerDataClient: jest.fn(() => ({})),
    }));
    jest.doMock('../../lib/solana/rpcMethods', () => ({
      createRpcMethods: jest.fn(() => ({})),
    }));
    jest.doMock('../../lib/wallets/resolver', () => ({
      resolveWalletSpecsWithRegistry: jest.fn(async (specs) => specs),
    }));

    await jest.isolateModulesAsync(async () => {
      const { setup } = require('../../lib/warchest/client');
      await expect(
        setup({ walletSpecs: [{ alias: 'alpha', pubkey: 'PUB' }], mode: 'daemon' }),
      ).rejects.toThrow('BootyBox missing required helpers');
    });
  });
});
