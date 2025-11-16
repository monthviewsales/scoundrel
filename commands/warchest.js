'use strict';

const readline = require('readline');
const chalk = require('chalk');
const walletRegistry = require('../lib/warchest/walletRegistry');

const COLOR_PALETTE = ['green', 'cyan', 'magenta', 'yellow', 'blue'];

/**
 * @typedef {Object} WalletRecord
 * @property {number|string} walletId
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} color
 * @property {boolean} hasPrivateKey
 * @property {string} keySource
 * @property {string|null} keyRef
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Create a readline interface bound to stdin/stdout.
 * @returns {readline.Interface}
 */
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask a question on the CLI and resolve with the user's input.
 * @param {readline.Interface} rl
 * @param {string} question
 * @returns {Promise<string>}
 */
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Map a stored color name to a chalk function.
 * @param {string|null} color
 * @returns {(text: string) => string}
 */
function colorizer(color) {
  if (!color) return (text) => text;
  switch (color) {
    case 'green':
      return chalk.green;
    case 'cyan':
      return chalk.cyan;
    case 'magenta':
      return chalk.magenta;
    case 'yellow':
      return chalk.yellow;
    case 'blue':
      return chalk.blue;
    case 'red':
      return chalk.red;
    default:
      return (text) => text;
  }
}

/**
 * Choose the next color from the palette based on existing wallets.
 * @param {WalletRecord[]} wallets
 * @returns {string}
 */
function pickNextColor(wallets) {
  const used = new Set(wallets.map((w) => w.color).filter(Boolean));
  for (const c of COLOR_PALETTE) {
    if (!used.has(c)) return c;
  }
  // If all are used, just cycle
  const idx = wallets.length % COLOR_PALETTE.length;
  return COLOR_PALETTE[idx];
}

/**
 * Handle `scoundrel warchest add`.
 * Interactive flow to add a wallet to the registry.
 */
async function handleAdd() {
  const rl = createInterface();

  try {
    const pubkey = await ask(rl, 'Enter wallet public key: ');
    if (!pubkey) {
      console.error(chalk.red('Public key is required. Aborting.'));
      return;
    }

    const typeAnswer = await ask(
      rl,
      'Is this wallet signing or watch-only? (s/w) [w]: '
    );
    const isSigning = typeAnswer.toLowerCase().startsWith('s');

    const alias = await ask(rl, 'Enter alias for this wallet (e.g. warlord): ');
    if (!alias) {
      console.error(chalk.red('Alias is required. Aborting.'));
      return;
    }

    const existing = await walletRegistry.getAllWallets();
    const color = pickNextColor(existing);

    const wallet = await walletRegistry.addWallet({
      alias,
      pubkey,
      color,
      hasPrivateKey: isSigning,
      keySource: 'none',
      keyRef: null,
    });

    const c = colorizer(wallet.color);
    const typeLabel = wallet.hasPrivateKey
      ? chalk.bold.green('[SIGNING]')
      : chalk.bold.yellow('[WATCH]');

    console.log(
      chalk.green('Added wallet to warchest:'),
      c(wallet.alias),
      typeLabel
    );
  } catch (err) {
    console.error(chalk.red('Failed to add wallet:'), err.message || err);
  } finally {
    rl.close();
  }
}

/**
 * Handle `scoundrel warchest list`.
 */
async function handleList() {
  try {
    const wallets = await walletRegistry.getAllWallets();

    if (!wallets || wallets.length === 0) {
      console.log(chalk.yellow('No wallets in your warchest yet.'));
      console.log('Use', chalk.cyan('scoundrel warchest add'), 'to add one.');
      return;
    }

    console.log(chalk.bold('\nYour Warchest Wallets:\n'));

    for (const w of wallets) {
      const c = colorizer(w.color);
      const typeLabel = w.hasPrivateKey
        ? chalk.bold.green('[SIGNING]')
        : chalk.bold.yellow('[WATCH]');

      console.log(
        ' -',
        c(w.alias),
        typeLabel,
        '\n    pubkey:',
        w.pubkey,
        '\n    color :',
        w.color || 'default',
        '\n    source:',
        w.keySource,
        '\n'
      );
    }
  } catch (err) {
    console.error(chalk.red('Failed to list wallets:'), err.message || err);
  }
}

/**
 * Handle `scoundrel warchest remove <alias>`.
 * @param {string|undefined} aliasArg
 */
async function handleRemove(aliasArg) {
  const rl = !aliasArg ? createInterface() : null;

  try {
    const alias = aliasArg || (await ask(rl, 'Enter alias to remove: '));
    if (!alias) {
      console.error(chalk.red('Alias is required to remove a wallet.'));
      return;
    }

    const ok = await walletRegistry.deleteWallet(alias);
    if (!ok) {
      console.error(
        chalk.yellow('No wallet found with alias:'),
        chalk.cyan(alias)
      );
      return;
    }

    console.log(chalk.green('Removed wallet:'), chalk.cyan(alias));
  } catch (err) {
    console.error(chalk.red('Failed to remove wallet:'), err.message || err);
  } finally {
    if (rl) rl.close();
  }
}

/**
 * Handle `scoundrel warchest set-color <alias> <color>`.
 * @param {string|undefined} aliasArg
 * @param {string|undefined} colorArg
 */
async function handleSetColor(aliasArg, colorArg) {
  const rl = !aliasArg || !colorArg ? createInterface() : null;

  try {
    const alias =
      aliasArg || (await ask(rl, 'Enter alias of the wallet to recolor: '));
    if (!alias) {
      console.error(chalk.red('Alias is required.'));
      return;
    }

    const color =
      colorArg ||
      (await ask(
        rl,
        `Enter color (${COLOR_PALETTE.join(', ')}), or blank for default: `
      ));

    const normalized = color ? color.toLowerCase() : null;
    if (normalized && !COLOR_PALETTE.includes(normalized)) {
      console.error(
        chalk.red('Invalid color. Must be one of:'),
        COLOR_PALETTE.join(', ')
      );
      return;
    }

    const ok = await walletRegistry.updateWalletColor(alias, normalized);
    if (!ok) {
      console.error(
        chalk.yellow('No wallet found with alias:'),
        chalk.cyan(alias)
      );
      return;
    }

    console.log(
      chalk.green('Updated color for'),
      chalk.cyan(alias),
      'to',
      normalized || 'default'
    );
  } catch (err) {
    console.error(chalk.red('Failed to set color:'), err.message || err);
  } finally {
    if (rl) rl.close();
  }
}

/**
 * Handle `scoundrel warchest -solo` for now by providing a simple
 * interactive chooser that prints details of a single wallet.
 * This is registry-only (no HUD yet).
 *
 * @returns {Promise<void>}
 */
async function handleSolo() {
  const rl = createInterface();

  try {
    const wallets = await walletRegistry.getAllWallets();
    if (!wallets || wallets.length === 0) {
      console.log(chalk.yellow('No wallets in your warchest yet.'));
      console.log('Use', chalk.cyan('scoundrel warchest add'), 'to add one.');
      return;
    }

    console.log(chalk.bold('\nSelect a wallet:\n'));
    wallets.forEach((w, idx) => {
      const c = colorizer(w.color);
      console.log(`${idx + 1}) ${c(w.alias)} (${w.pubkey})`);
    });
    console.log(`${wallets.length + 1}) OTHER (add a new wallet)`);

    const choiceRaw = await ask(rl, '\nEnter choice number: ');
    const choice = parseInt(choiceRaw, 10);

    if (Number.isNaN(choice) || choice < 1 || choice > wallets.length + 1) {
      console.error(chalk.red('Invalid choice.'));
      return;
    }

    if (choice === wallets.length + 1) {
      console.log(
        chalk.yellow(
          'Use `scoundrel warchest add` to register a new wallet for now.'
        )
      );
      return;
    }

    const w = wallets[choice - 1];
    const c = colorizer(w.color);
    const typeLabel = w.hasPrivateKey
      ? chalk.bold.green('[SIGNING]')
      : chalk.bold.yellow('[WATCH]');

    console.log('\n');
    console.log(chalk.bold('Selected wallet:'));
    console.log('  alias :', c(w.alias), typeLabel);
    console.log('  pubkey:', w.pubkey);
    console.log('  color :', w.color || 'default');
    console.log('  source:', w.keySource);
  } catch (err) {
    console.error(chalk.red('Failed to select wallet:'), err.message || err);
  } finally {
    rl.close();
  }
}

/**
 * Entry point for the warchest command.
 *
 * @param {string[]} argv Arguments after `warchest`.
 * @returns {Promise<void>}
 */
async function run(argv) {
  const args = argv.slice();

  // Support `scoundrel warchest -solo` for a registry-only selection flow.
  if (args.includes('-solo') || args.includes('--solo')) {
    await handleSolo();
    return;
  }

  const sub = args[0];

  switch (sub) {
    case 'add':
      await handleAdd();
      break;
    case 'list':
    case undefined:
      // Default to list when no subcommand provided
      await handleList();
      break;
    case 'remove':
      await handleRemove(args[1]);
      break;
    case 'set-color':
      await handleSetColor(args[1], args[2]);
      break;
    default:
      console.log(chalk.bold('Usage:'));
      console.log('  scoundrel warchest add');
      console.log('  scoundrel warchest list');
      console.log('  scoundrel warchest remove <alias>');
      console.log('  scoundrel warchest set-color <alias> <color>');
      console.log('  scoundrel warchest --solo   # or: -s');
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
