'use strict';

const React = require('react');
const { render } = require('ink');

const logger = require('../logger');
const walletRegistry = require('../wallets/walletRegistry');
const walletManagement = require('../wallets/walletManagement');
const { WalletManagerApp } = require('../wallets/inkWalletManager');

function parseArgs(argv) {
  const args = argv.slice();
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  return { args, flags };
}

/**
 * Entry point for the `scoundrel wallet` command.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function run(argv) {
  const { args, flags } = parseArgs(argv);
  const noTui = flags.has('--no-tui');
  const soloMode = flags.has('-s') || flags.has('--solo') || flags.has('-solo');

  if (!noTui) {
    const { waitUntilExit } = render(
      React.createElement(WalletManagerApp, {
        initialRoute: soloMode ? 'solo' : 'menu',
        onComplete: (wallet) => {
          if (wallet) {
            logger.info('\nSelected wallet:');
            logger.info(`  alias : ${wallet.alias}`);
            logger.info(`  pubkey: ${wallet.pubkey}`);
            logger.info(`  color : ${wallet.color || 'default'}`);
          }
        },
      })
    );
    await waitUntilExit();
    return;
  }

  if (soloMode) {
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
      logger.info('  scoundrel wallet [--no-tui]');
      logger.info('  scoundrel wallet add');
      logger.info('  scoundrel wallet list');
      logger.info('  scoundrel wallet remove <alias>');
      logger.info('  scoundrel wallet set-color <alias> <color>');
      logger.info('  scoundrel wallet options         # interactive options editor');
      logger.info('  scoundrel wallet --solo   # or: -s');
      logger.info('  scoundrel wallet --no-tui # legacy CLI prompts for automation');
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
