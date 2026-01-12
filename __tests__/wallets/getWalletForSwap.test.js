const { createKeyPairSignerFromBytes } = require('@solana/kit');
const { hasUsablePrivateKey, getPrivateKeyForWallet } = require('../../lib/wallets/secretProvider');
const registry = require('../../lib/wallets/walletRegistry');
const getWalletForSwap = require('../../lib/wallets/getWalletForSwap');

jest.mock('@solana/kit', () => ({
  createKeyPairSignerFromBytes: jest.fn(),
}));

jest.mock('../../lib/wallets/secretProvider', () => ({
  hasUsablePrivateKey: jest.fn(),
  getPrivateKeyForWallet: jest.fn(),
}));

jest.mock('../../lib/wallets/walletRegistry', () => ({
  getWalletByAlias: jest.fn(),
}));

describe('getWalletForSwap', () => {
  const keyArray = `[${Array(64).fill(7).join(',')}]`;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves an alias and builds a signer-backed wallet', async () => {
    const walletRow = { alias: 'alpha', pubkey: 'AlphaPub', walletId: 42 };
    registry.getWalletByAlias.mockResolvedValue(walletRow);
    hasUsablePrivateKey.mockReturnValue(true);
    getPrivateKeyForWallet.mockReturnValue(keyArray);
    createKeyPairSignerFromBytes.mockResolvedValue({ address: walletRow.pubkey });

    const wallet = await getWalletForSwap('alpha');

    expect(registry.getWalletByAlias).toHaveBeenCalledWith('alpha');
    expect(getPrivateKeyForWallet).toHaveBeenCalledWith(walletRow, { requirePrivateKey: true });
    expect(createKeyPairSignerFromBytes).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(wallet).toMatchObject({
      alias: 'alpha',
      pubkey: 'AlphaPub',
      walletId: 42,
      hasPrivateKey: true,
    });
    expect(wallet.signer).toEqual({ address: 'AlphaPub' });
  });

  it('returns a view-only wallet when no private key is available and not required', async () => {
    const walletRow = { alias: 'observer', pubkey: 'ObserverPub', walletId: 99, usage_type: 'observe' };
    hasUsablePrivateKey.mockReturnValue(false);

    const wallet = await getWalletForSwap(walletRow, { requirePrivateKey: false });

    expect(getPrivateKeyForWallet).not.toHaveBeenCalled();
    expect(createKeyPairSignerFromBytes).not.toHaveBeenCalled();
    expect(wallet).toEqual({
      walletId: 99,
      alias: 'observer',
      pubkey: 'ObserverPub',
      signer: null,
      hasPrivateKey: false,
      usageType: 'observe',
      strategy: undefined,
      raw: walletRow,
    });
  });

  it('throws when the derived signer address does not match the stored pubkey', async () => {
    const walletRow = { alias: 'bravo', pubkey: 'ExpectedPub', walletId: 2 };
    hasUsablePrivateKey.mockReturnValue(true);
    getPrivateKeyForWallet.mockReturnValue(keyArray);
    createKeyPairSignerFromBytes.mockResolvedValue({ address: 'DifferentPub' });

    await expect(getWalletForSwap(walletRow)).rejects.toThrow('does not match stored pubkey');
  });

  it('throws when an alias cannot be resolved', async () => {
    registry.getWalletByAlias.mockResolvedValue(null);

    await expect(getWalletForSwap('missing-alias')).rejects.toThrow('No wallet found for alias');
  });
});
