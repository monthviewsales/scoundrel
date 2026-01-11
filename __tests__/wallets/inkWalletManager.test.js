'use strict';

const React = require('react');

jest.mock('../../lib/wallets/walletRegistry', () => ({
  getAllWallets: jest.fn(),
  addWallet: jest.fn(),
  updateWalletColor: jest.fn(),
  deleteWallet: jest.fn(),
}));

jest.mock('../../lib/wallets/optionsManager', () => ({
  USAGE_TYPES: ['other', 'kol'],
  updateWalletOptions: jest.fn(),
}));

const { EventEmitter } = require('events');
const h = React.createElement;
let render;

describe('inkWalletManager', () => {
  let refSnapshot;

  beforeAll(async () => {
    const inkTestingLibrary = await import('ink-testing-library');
    render = inkTestingLibrary.render;
    refSnapshot = {
      ref: EventEmitter.prototype.ref,
      unref: EventEmitter.prototype.unref,
    };
    EventEmitter.prototype.ref = function ref() {};
    EventEmitter.prototype.unref = function unref() {};
  });

  afterAll(() => {
    EventEmitter.prototype.ref = refSnapshot.ref;
    EventEmitter.prototype.unref = refSnapshot.unref;
  });

  test('renders list view with wallets', async () => {
    const registry = {
      getAllWallets: jest.fn().mockResolvedValue([
        { alias: 'alpha', pubkey: 'ABCDEFGH1234567890', color: 'blue', hasPrivateKey: false },
      ]),
    };

    const { loadWalletManagerApp } = require('../../lib/wallets/inkWalletManager');
    const { WalletManagerApp } = await loadWalletManagerApp();
    const { lastFrame, unmount } = render(h(WalletManagerApp, { initialRoute: 'list', registry }));

    await new Promise((resolve) => setImmediate(resolve));

    const frame = lastFrame();
    expect(frame).toContain('Your wallets');
    expect(frame).toContain('alpha');

    unmount();
  });

  test('renders empty list message', async () => {
    const registry = {
      getAllWallets: jest.fn().mockResolvedValue([]),
    };

    const { loadWalletManagerApp } = require('../../lib/wallets/inkWalletManager');
    const { WalletManagerApp } = await loadWalletManagerApp();
    const { lastFrame, unmount } = render(h(WalletManagerApp, { initialRoute: 'list', registry }));

    await new Promise((resolve) => setImmediate(resolve));

    const frame = lastFrame();
    expect(frame).toContain('No wallets found');

    unmount();
  });
});
