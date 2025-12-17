'use strict';

const logger = require('../logger');
const walletRegistry = require('../wallets/walletRegistry');
const walletManagement = require('../wallets/walletManagement');

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

  const logAndRethrow = (prefix, err) => {
    const msg =
      (err && err.message) ||
      (typeof err === 'string' ? err : (() => {
        try {
          return JSON.stringify(err);
        } catch (_) {
          return String(err);
        }
      })());

    logger.error(`${prefix}${msg ? ' ' + msg : ''}`);
    if (err && err.stack) logger.error(err.stack);
    throw err;
  };

  if (!noTui) {
    try {
      // Ink is ESM (and currently uses top-level await), so it must be loaded via dynamic import
      // when we’re running in a CommonJS codebase.
      const React = require('react');
      const { render } = await import('ink');

      // Load the TUI only when needed to avoid pulling Ink into non-TUI flows.
      // `inkWalletManager` also lazy-loads Ink via dynamic import to stay CommonJS-safe.
      const { loadWalletManagerApp } = require('../wallets/inkWalletManager');
      const { WalletManagerApp } = await loadWalletManagerApp();

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
    } catch (err) {
      logAndRethrow('[scoundrel] ❌ wallet TUI failed:', err);
    }
  }

  try {
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
  } catch (err) {
    logAndRethrow('[scoundrel] ❌ wallet command failed:', err);
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
