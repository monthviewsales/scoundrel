'use strict';

const logger = require('../logger');
const walletRegistry = require('../wallets/registry');
const walletManagement = require('../wallets/walletManagement');

/**
 * Entry point for the `scoundrel wallet` command.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function run(argv) {
  const args = argv.slice();

  if (args.includes('-s') || args.includes('--solo') || args.includes('-solo')) {
    await walletManagement.soloSelectWallet();
    return;
  }

  const sub = args[0];

  switch (sub) {
    case 'add':
      await walletManagement.addWalletInteractive();
      break;
    case 'list':
    case undefined:
      await walletManagement.listWallets();
      break;
    case 'remove':
      await walletManagement.removeWallet(args[1]);
      break;
    case 'set-color':
      await walletManagement.setWalletColor(args[1], args[2]);
      break;
    case 'options':
    case 'configure':
      await walletManagement.configureWalletOptions();
      break;
    default:
      logger.info('Usage:');
      logger.info('  scoundrel wallet add');
      logger.info('  scoundrel wallet list');
      logger.info('  scoundrel wallet remove <alias>');
      logger.info('  scoundrel wallet set-color <alias> <color>');
      logger.info('  scoundrel wallet options         # interactive options editor');
      logger.info('  scoundrel wallet --solo   # or: -s');
  }
}

module.exports = {
  run,
  getAllWallets: walletRegistry.getAllWallets,
  getWalletByAlias: walletRegistry.getWalletByAlias,
  addWallet: walletRegistry.addWallet,
  deleteWallet: walletRegistry.deleteWallet,
  updateWalletColor: walletRegistry.updateWalletColor,
};
