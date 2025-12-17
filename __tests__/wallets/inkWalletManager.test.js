'use strict';

const React = require('react');

jest.mock('ink', () => {
  return {
    Box: () => null,
    Text: () => null,
    useApp: () => ({ exit: jest.fn() }),
    useInput: () => {},
  };
});

jest.mock('ink-text-input', () => ({
  default: () => null,
}));

const { WalletManagerApp } = require('../../lib/wallets/inkWalletManager');

function createRegistry(wallets = []) {
  return {
    getAllWallets: jest.fn().mockResolvedValue(wallets),
    addWallet: jest.fn().mockResolvedValue({}),
    updateWalletColor: jest.fn().mockResolvedValue(true),
    deleteWallet: jest.fn().mockResolvedValue(true),
  };
}

describe('WalletManagerApp', () => {
  test('exposes a component function', () => {
    expect(typeof WalletManagerApp).toBe('function');
  });

  test('creates element with injected registry without throwing', () => {
    const registry = createRegistry([{ alias: 'a', pubkey: 'p' }]);
    const element = React.createElement(WalletManagerApp, { registry, initialRoute: 'menu' });
    expect(element).toBeTruthy();
  });
});
