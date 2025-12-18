'use strict';

const { resolveAutopsyWallet } = require('../../lib/cli/autopsyWalletResolver');

describe('resolveAutopsyWallet', () => {
  test('maps alias to registry pubkey and preserves alias as label', async () => {
    const resolver = {
      resolveAliasOrAddress: jest.fn().mockResolvedValue({
        wallet: { alias: 'alpha', pubkey: 'PubkeyAlpha' },
      }),
    };

    const result = await resolveAutopsyWallet({ walletLabel: 'alpha', resolver });

    expect(result).toEqual({ walletLabel: 'alpha', walletAddress: 'PubkeyAlpha' });
    expect(resolver.resolveAliasOrAddress).toHaveBeenCalledWith('alpha');
  });

  test('uses caller label when provided with base58 address', async () => {
    const resolver = {
      resolveAliasOrAddress: jest.fn().mockResolvedValue({
        wallet: { alias: null, pubkey: 'Base58Pubkey' },
      }),
    };

    const result = await resolveAutopsyWallet({
      walletLabel: 'custom-label',
      walletAddress: 'Base58Pubkey',
      resolver,
    });

    expect(result).toEqual({ walletLabel: 'custom-label', walletAddress: 'Base58Pubkey' });
    expect(resolver.resolveAliasOrAddress).toHaveBeenCalledWith('Base58Pubkey');
  });

  test('throws when resolver cannot find a wallet', async () => {
    const resolver = {
      resolveAliasOrAddress: jest.fn().mockResolvedValue(null),
    };

    await expect(resolveAutopsyWallet({ walletLabel: 'missing', resolver })).rejects.toThrow(
      '[autopsy] Unable to resolve wallet from input: missing'
    );
  });
});
