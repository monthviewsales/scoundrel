'use strict';

jest.mock('../../lib/wallets/walletRegistry', () => ({
  getWalletByAlias: jest.fn(),
}));

jest.mock('../../lib/wallets/secretProvider', () => ({
  getPrivateKeyForWallet: jest.fn(),
}));

const getWalletPrivateKey = require('../../lib/wallets/getWalletPrivateKey');
const registry = require('../../lib/wallets/walletRegistry');
const { getPrivateKeyForWallet } = require('../../lib/wallets/secretProvider');

describe('getWalletPrivateKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires an alias or address', async () => {
    await expect(getWalletPrivateKey('')).rejects.toThrow('alias or address is required');
  });

  test('errors when wallet is not found', async () => {
    registry.getWalletByAlias.mockResolvedValue(null);
    await expect(getWalletPrivateKey('alpha')).rejects.toThrow('No wallet found');
    expect(registry.getWalletByAlias).toHaveBeenCalledWith('alpha');
  });

  test('errors when no usable private key is resolved', async () => {
    registry.getWalletByAlias.mockResolvedValue({ alias: 'alpha' });
    getPrivateKeyForWallet.mockReturnValue(null);

    await expect(getWalletPrivateKey('alpha')).rejects.toThrow('has no usable private key');
  });

  test('returns the resolved private key', async () => {
    registry.getWalletByAlias.mockResolvedValue({ alias: 'alpha' });
    getPrivateKeyForWallet.mockReturnValue('secret-key');

    await expect(getWalletPrivateKey('alpha')).resolves.toBe('secret-key');
    expect(getPrivateKeyForWallet).toHaveBeenCalledWith(
      { alias: 'alpha' },
      { requirePrivateKey: true }
    );
  });
});
