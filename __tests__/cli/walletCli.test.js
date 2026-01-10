'use strict';

jest.mock('../../lib/wallets/walletManagement', () => ({
  soloSelectWallet: jest.fn(),
  addWalletInteractive: jest.fn(),
  listWallets: jest.fn(),
  removeWallet: jest.fn(),
  setWalletColor: jest.fn(),
  configureWalletOptions: jest.fn(),
}));

jest.mock('../../lib/wallets/walletRegistry', () => ({
  getAllWallets: jest.fn(),
  getWalletByAlias: jest.fn(),
  addWallet: jest.fn(),
  deleteWallet: jest.fn(),
  updateWalletColor: jest.fn(),
}));

const logger = require('../../lib/logger');
const walletManagement = require('../../lib/wallets/walletManagement');

describe('wallet CLI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('lists wallets by default in no-tui mode', async () => {
    const { run } = require('../../lib/cli/walletCli');
    await run(['list', '--no-tui']);

    expect(walletManagement.listWallets).toHaveBeenCalled();
  });

  test('runs solo selection in no-tui mode', async () => {
    const { run } = require('../../lib/cli/walletCli');
    await run(['--no-tui', '-s']);

    expect(walletManagement.soloSelectWallet).toHaveBeenCalled();
  });

  test('routes add subcommand in no-tui mode', async () => {
    const { run } = require('../../lib/cli/walletCli');
    await run(['add', '--no-tui']);

    expect(walletManagement.addWalletInteractive).toHaveBeenCalled();
  });

  test('prints usage on unknown subcommand', async () => {
    const { run } = require('../../lib/cli/walletCli');
    await run(['unknown', '--no-tui']);

    expect(logger.info).toHaveBeenCalledWith('Usage:');
  });
});
