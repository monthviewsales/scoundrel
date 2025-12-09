'use strict';

jest.mock('../../db', () => ({
  init: jest.fn().mockResolvedValue(),
  upsertKolWalletFromDossier: jest.fn(),
  ensureKolWalletForProfile: jest.fn(),
}));

const BootyBox = require('../../db');
const { ensureKolWallet } = require('../../lib/wallets/kolManager');

describe('kolManager.ensureKolWallet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('no-ops when wallet address is missing', async () => {
    await ensureKolWallet({ walletAddress: '', alias: 'Test' });
    expect(BootyBox.init).not.toHaveBeenCalled();
    expect(BootyBox.upsertKolWalletFromDossier).not.toHaveBeenCalled();
  });

  it('calls upsertKolWalletFromDossier when available', async () => {
    await ensureKolWallet({ walletAddress: 'Wallet11111111111111111111111111111111', alias: 'Tester' });
    expect(BootyBox.init).toHaveBeenCalledTimes(1);
    expect(BootyBox.upsertKolWalletFromDossier).toHaveBeenCalledWith({
      wallet: 'Wallet11111111111111111111111111111111',
      traderName: 'Tester',
      color: null,
    });
  });

  it('falls back to ensureKolWalletForProfile on upsert failure', async () => {
    BootyBox.upsertKolWalletFromDossier.mockImplementation(() => {
      throw new Error('boom');
    });
    await ensureKolWallet({ walletAddress: 'Wallet22222222222222222222222222222222', alias: 'AliasB' });
    expect(BootyBox.ensureKolWalletForProfile).toHaveBeenCalledWith(
      'Wallet22222222222222222222222222222222',
      'AliasB',
    );
  });
});
