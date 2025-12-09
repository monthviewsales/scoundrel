'use strict';

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockRegistry = {
  getWalletByAlias: jest.fn(),
  getAllWallets: jest.fn(),
  addWallet: jest.fn(),
  updateWalletColor: jest.fn(),
  deleteWallet: jest.fn(),
};

jest.mock('../../lib/wallets/registry', () => mockRegistry);

const mockSelection = {
  selectWalletInteractively: jest.fn(),
  COLOR_PALETTE: ['green'],
  pickNextColor: jest.fn(),
};

jest.mock('../../lib/wallets/walletSelection', () => mockSelection);

const walletManagement = require('../../lib/wallets/walletManagement');

describe('walletManagement.soloSelectWallet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('looks up registry metadata when selection returns a known alias', async () => {
    mockSelection.selectWalletInteractively.mockResolvedValue({
      walletLabel: 'alpha',
      walletAddress: 'PubAlpha',
      walletColor: 'blue',
    });
    mockRegistry.getWalletByAlias.mockResolvedValue({
      alias: 'alpha',
      pubkey: 'PubAlpha',
      hasPrivateKey: false,
      keySource: 'env',
    });

    await walletManagement.soloSelectWallet();

    expect(mockRegistry.getWalletByAlias).toHaveBeenCalledWith('alpha');
  });

  it('skips registry lookup when selecting custom address', async () => {
    mockSelection.selectWalletInteractively.mockResolvedValue({
      walletLabel: 'other',
      walletAddress: 'CustomPub',
      walletColor: null,
    });

    await walletManagement.soloSelectWallet();

    expect(mockRegistry.getWalletByAlias).not.toHaveBeenCalled();
  });
});
