'use strict';

const readline = require('readline');
const chalk = require('chalk');
const walletRegistry = require('../lib/wallets/registry');
const walletOptions = require('../lib/wallets/optionsManager');
const logger = require('../lib/logger');

const COLOR_PALETTE = ['green', 'cyan', 'magenta', 'yellow', 'blue'];
const { USAGE_TYPES } = walletOptions;

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

function shortenPubkey(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') return '';
  if (pubkey.length <= 10) return pubkey;
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

async function promptYesNo(rl, question, current) {
  while (true) {
    const defaultHint = current ? 'Y/n' : 'y/N';
    const raw = await ask(rl, `${question} (${defaultHint}): `);
    if (!raw) return !!current;
    const normalized = raw.toLowerCase();
    if (normalized === 'y' || normalized === 'yes') return true;
    if (normalized === 'n' || normalized === 'no') return false;
    logger.warn('Please answer with y or n.');
  }
}

async function promptUsageType(rl, current) {
  const normalized = (current && current.toLowerCase()) || 'other';
  while (true) {
    logger.info('\nUsage types:');
    USAGE_TYPES.forEach((type, idx) => {
      const marker = type === normalized ? ' [current]' : '';
      logger.info(` ${idx + 1}) ${type}${marker}`);
    });

    const defaultIdx = Math.max(USAGE_TYPES.indexOf(normalized), 0) + 1;
    const raw = await ask(rl, `Select usage type [${defaultIdx}]: `);
    if (!raw) return normalized;

    const numeric = Number(raw);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= USAGE_TYPES.length) {
      return USAGE_TYPES[numeric - 1];
    }

    const maybeType = raw.toLowerCase();
    if (USAGE_TYPES.includes(maybeType)) {
      return maybeType;
    }

    logger.warn('Invalid choice. Enter the list number or type name.');
  }
}

async function promptStrategyId(rl, current) {
  const label = current ? `${current}` : 'none';
  const raw = await ask(
    rl,
    `Strategy ID (blank=keep, '-'=clear) [${label}]: `
  );

  if (!raw) return current;
  if (raw === '-') return null;
  return raw;
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
      logger.error(chalk.red('Public key is required. Aborting.'));
      return;
    }

    const typeAnswer = await ask(
      rl,
      'Is this wallet signing or watch-only? (s/w) [w]: '
    );
    const isSigning = typeAnswer.toLowerCase().startsWith('s');

    const alias = await ask(rl, 'Enter alias for this wallet (e.g. warlord): ');
    if (!alias) {
      logger.error(chalk.red('Alias is required. Aborting.'));
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

    logger.info(
      chalk.green('Added wallet to warchest:'),
      c(wallet.alias),
      typeLabel
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to add wallet: ${msg}`));
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
      logger.info(chalk.yellow('No wallets in your warchest yet.'));
      logger.info('Use', chalk.cyan('scoundrel warchest add'), 'to add one.');
      return;
    }

    logger.info(chalk.bold('\nYour Warchest Wallets:\n'));

    for (const w of wallets) {
      const c = colorizer(w.color);
      const typeLabel = w.hasPrivateKey
        ? chalk.bold.green('[SIGNING]')
        : chalk.bold.yellow('[WATCH]');

      const line =
        ` - ${c(w.alias)} ${typeLabel}\n` +
        `    pubkey: ${w.pubkey}\n` +
        `    color : ${w.color || 'default'}\n` +
        `    source: ${w.keySource}\n`;

      logger.info(line);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to list wallets: ${msg}`));
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
      logger.error(chalk.red('Alias is required to remove a wallet.'));
      return;
    }

    const ok = await walletRegistry.deleteWallet(alias);
    if (!ok) {
      logger.error(
        chalk.yellow('No wallet found with alias:'),
        chalk.cyan(alias)
      );
      return;
    }

    logger.info(chalk.green('Removed wallet:'), chalk.cyan(alias));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to remove wallet: ${msg}`));
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
      logger.error(chalk.red('Alias is required.'));
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
      logger.error(
        chalk.red('Invalid color. Must be one of:'),
        COLOR_PALETTE.join(', ')
      );
      return;
    }

    const ok = await walletRegistry.updateWalletColor(alias, normalized);
    if (!ok) {
      logger.error(
        chalk.yellow('No wallet found with alias:'),
        chalk.cyan(alias)
      );
      return;
    }

    logger.info(
      chalk.green('Updated color for'),
      chalk.cyan(alias),
      'to',
      normalized || 'default'
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to set color: ${msg}`));
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
      logger.info(chalk.yellow('No wallets in your warchest yet.'));
      logger.info('Use', chalk.cyan('scoundrel warchest add'), 'to add one.');
      return;
    }

    logger.info(chalk.bold('\nSelect a wallet:\n'));
    wallets.forEach((w, idx) => {
      const c = colorizer(w.color);
      logger.info(`${idx + 1}) ${c(w.alias)} (${w.pubkey})`);
    });
    logger.info(`${wallets.length + 1}) OTHER (add a new wallet)`);

    const choiceRaw = await ask(rl, '\nEnter choice number: ');
    const choice = parseInt(choiceRaw, 10);

    if (Number.isNaN(choice) || choice < 1 || choice > wallets.length + 1) {
      logger.error(chalk.red('Invalid choice.'));
      return;
    }

    if (choice === wallets.length + 1) {
      logger.log(
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

    logger.info('\n');
    logger.info(chalk.bold('Selected wallet:'));
    logger.info('  alias :', c(w.alias), typeLabel);
    logger.info('  pubkey:', w.pubkey);
    logger.info('  color :', w.color || 'default');
    logger.info('  source:', w.keySource);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to select wallet: ${msg}`));
  } finally {
    rl.close();
  }
}

/**
 * Handle `scoundrel warchest options`.
 * Allows selecting a wallet and updating key registry options.
 */
async function handleOptions() {
  const rl = createInterface();

  try {
    const wallets = await walletRegistry.getAllWallets();
    if (!wallets || wallets.length === 0) {
      logger.info(chalk.yellow('No wallets in your warchest yet.'));
      logger.info('Use', chalk.cyan('scoundrel warchest add'), 'to add one.');
      return;
    }

    logger.info(chalk.bold('\nSelect a wallet to configure:\n'));
    wallets.forEach((w, idx) => {
      const c = colorizer(w.color);
      logger.info(`${idx + 1}) ${c(w.alias)} (${shortenPubkey(w.pubkey)})`);
    });

    const choiceRaw = await ask(rl, `\nEnter choice (1-${wallets.length}): `);
    const choice = parseInt(choiceRaw, 10);
    if (Number.isNaN(choice) || choice < 1 || choice > wallets.length) {
      logger.error(chalk.red('Invalid selection.'));
      return;
    }

    const wallet = wallets[choice - 1];
    logger.info('\nCurrent settings:');
    logger.info(`  usageType       : ${wallet.usageType || 'other'}`);
    logger.info(`  autoAttachHUD   : ${wallet.autoAttachWarchest ? 'yes' : 'no'}`);
    logger.info(`  defaultFunding  : ${wallet.isDefaultFunding ? 'yes' : 'no'}`);
    logger.info(`  strategyId      : ${wallet.strategyId || 'none'}`);

    const usageType = await promptUsageType(rl, wallet.usageType || 'other');
    const autoAttach = await promptYesNo(
      rl,
      'Auto-attach to the warchest daemon?',
      !!wallet.autoAttachWarchest
    );
    const defaultFunding = await promptYesNo(
      rl,
      'Mark as default funding wallet?',
      !!wallet.isDefaultFunding
    );
    const strategyId = await promptStrategyId(rl, wallet.strategyId);

    const updates = {};
    if (usageType !== (wallet.usageType || 'other')) updates.usageType = usageType;
    if (autoAttach !== !!wallet.autoAttachWarchest) updates.autoAttachWarchest = autoAttach;
    if (defaultFunding !== !!wallet.isDefaultFunding) updates.isDefaultFunding = defaultFunding;
    if (strategyId !== wallet.strategyId) updates.strategyId = strategyId;

    if (!Object.keys(updates).length) {
      logger.info(chalk.yellow('No changes submitted.'));
      return;
    }

    const updated = await walletOptions.updateWalletOptions(wallet.alias, updates);
    logger.info(
      chalk.green('\nUpdated wallet:'),
      chalk.cyan(wallet.alias),
      `(${shortenPubkey(wallet.pubkey)})`
    );
    logger.info(`  usageType       : ${updated.usageType}`);
    logger.info(`  autoAttachHUD   : ${updated.autoAttachWarchest ? 'yes' : 'no'}`);
    logger.info(`  defaultFunding  : ${updated.isDefaultFunding ? 'yes' : 'no'}`);
    logger.info(`  strategyId      : ${updated.strategyId || 'none'}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to update wallet options: ${msg}`));
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

  // Support `scoundrel warchest --solo` or `-s` for a registry-only selection flow.
  if (args.includes('-s') || args.includes('--solo') || args.includes('-solo')) {
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
    case 'options':
    case 'configure':
      await handleOptions();
      break;
    default:
      logger.info(chalk.bold('Usage:'));
      logger.info('  scoundrel warchest add');
      logger.info('  scoundrel warchest list');
      logger.info('  scoundrel warchest remove <alias>');
      logger.info('  scoundrel warchest set-color <alias> <color>');
      logger.info('  scoundrel warchest options         # interactive options editor');
      logger.info('  scoundrel warchest --solo   # or: -s');
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
