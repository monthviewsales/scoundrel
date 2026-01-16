'use strict';

const readline = require('readline');
const chalk = require('chalk');

const walletRegistry = require('./walletRegistry');
const walletOptions = require('./optionsManager');
const logger = require('../logger');
const { upsertWalletSecret, deleteWalletSecret } = require('./keystore');
const {
  COLOR_PALETTE,
  pickNextColor,
  selectWalletInteractively,
} = require('./walletSelection');

/**
 * Thin CLI-facing helpers for wallet CRUD + option flows.
 * These functions encapsulate readline usage so the CLI commands,
 * daemon, and other features can share UX patterns.
 */

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

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

async function promptKeySource(rl) {
  while (true) {
    const raw = await ask(rl, 'Key source (k=keychain, e=env, n=none) [k]: ');
    const normalized = (raw || '').trim().toLowerCase();
    if (!normalized || normalized === 'k' || normalized === 'keychain') return 'keychain';
    if (normalized === 'e' || normalized === 'env') return 'env';
    if (normalized === 'n' || normalized === 'none') return 'none';
    logger.warn('Enter k (keychain), e (env), or n (none).');
  }
}

async function promptEnvVar(rl) {
  while (true) {
    const raw = await ask(rl, 'Env var name (e.g. WALLET_KEY_ALPHA): ');
    const value = (raw || '').trim();
    if (value) return value;
    logger.warn('Env var name is required.');
  }
}

async function promptSecret(rl) {
  while (true) {
    const raw = await ask(rl, 'Paste private key (base58 or id.json array): ');
    const value = (raw || '').trim();
    if (value) return value;
    logger.warn('Private key is required.');
  }
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
    walletOptions.USAGE_TYPES.forEach((type, idx) => {
      const marker = type === normalized ? ' [current]' : '';
      logger.info(` ${idx + 1}) ${type}${marker}`);
    });

    const defaultIdx = Math.max(walletOptions.USAGE_TYPES.indexOf(normalized), 0) + 1;
    const raw = await ask(rl, `Select usage type [${defaultIdx}]: `);
    if (!raw) return normalized;

    const numeric = Number(raw);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= walletOptions.USAGE_TYPES.length) {
      return walletOptions.USAGE_TYPES[numeric - 1];
    }

    const maybeType = raw.toLowerCase();
    if (walletOptions.USAGE_TYPES.includes(maybeType)) {
      return maybeType;
    }

    logger.warn('Invalid choice. Enter the list number or type name.');
  }
}

async function promptStrategy(rl, current) {
  const label = current ? `${current}` : 'none';
  const raw = await ask(rl, `Strategy (blank=keep, '-'=clear) [${label}]: `);

  if (!raw) return current;
  if (raw === '-') return null;
  return raw;
}

async function addWalletInteractive() {
  const rl = createInterface();

  try {
    const pubkey = await ask(rl, 'Enter wallet public key: ');
    if (!pubkey) {
      logger.error(chalk.red('Public key is required. Aborting.'));
      return;
    }

    const typeAnswer = await ask(rl, 'Is this wallet signing or watch-only? (s/w) [w]: ');
    const isSigning = typeAnswer.toLowerCase().startsWith('s');

    const alias = await ask(rl, 'Enter alias for this wallet (e.g. warlord): ');
    if (!alias) {
      logger.error(chalk.red('Alias is required. Aborting.'));
      return;
    }

    const existing = await walletRegistry.getAllWallets();
    const color = pickNextColor(existing);

    let keySource = 'none';
    let keyRef = null;
    let secretValue = null;
    let signing = isSigning;
    if (isSigning) {
      keySource = await promptKeySource(rl);
      if (keySource === 'env') {
        keyRef = await promptEnvVar(rl);
      } else if (keySource === 'keychain') {
        secretValue = await promptSecret(rl);
      } else {
        signing = false;
        keySource = 'none';
      }
    }

    const wallet = await walletRegistry.addWallet({
      alias,
      pubkey,
      color,
      hasPrivateKey: signing,
      keySource,
      keyRef,
    });

    if (signing && keySource === 'keychain') {
      try {
        const walletId = wallet.walletId !== undefined ? wallet.walletId : wallet.wallet_id;
        const stored = await upsertWalletSecret({ walletId, secret: secretValue });
        await walletRegistry.updateWalletOptions(wallet.alias, {
          keySource: 'keychain',
          keyRef: String(stored.secretId),
          hasPrivateKey: true,
        });
      } catch (err) {
        await walletRegistry.deleteWallet(wallet.alias);
        throw err;
      }
    }

    const c = colorizer(wallet.color);
    const typeLabel = wallet.hasPrivateKey
      ? chalk.bold.green('[SIGNING]')
      : chalk.bold.yellow('[WATCH]');

    logger.info(chalk.green('Added wallet to warchest:'), c(wallet.alias), typeLabel);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to add wallet: ${msg}`));
  } finally {
    rl.close();
  }
}

/**
 * Update the private key source for a wallet.
 *
 * @param {string} [aliasArg]
 * @returns {Promise<void>}
 */
async function setWalletKeyInteractive(aliasArg) {
  const rl = !aliasArg ? createInterface() : null;

  try {
    const alias = aliasArg || (await ask(rl, 'Enter alias of the wallet to update: '));
    if (!alias) {
      logger.error(chalk.red('Alias is required.'));
      return;
    }

    const wallet = await walletRegistry.getWalletByAlias(alias);
    if (!wallet) {
      logger.error(chalk.red('No wallet found with alias:'), chalk.cyan(alias));
      return;
    }

    const source = await promptKeySource(rl);
    const walletId = wallet.walletId !== undefined ? wallet.walletId : wallet.wallet_id;

    if (source === 'none') {
      await deleteWalletSecret({ keyRef: wallet.keyRef, walletId });
      await walletRegistry.updateWalletOptions(alias, {
        hasPrivateKey: false,
        keySource: 'none',
        keyRef: null,
      });
      logger.info(chalk.green('Cleared signing key for'), chalk.cyan(alias));
      return;
    }

    if (source === 'env') {
      const envVar = await promptEnvVar(rl);
      await deleteWalletSecret({ keyRef: wallet.keyRef, walletId });
      await walletRegistry.updateWalletOptions(alias, {
        hasPrivateKey: true,
        keySource: 'env',
        keyRef: envVar,
      });
      logger.info(chalk.green('Updated env key for'), chalk.cyan(alias));
      return;
    }

    const secretValue = await promptSecret(rl);
    const stored = await upsertWalletSecret({ walletId, secret: secretValue });
    await walletRegistry.updateWalletOptions(alias, {
      hasPrivateKey: true,
      keySource: 'keychain',
      keyRef: String(stored.secretId),
    });
    logger.info(chalk.green('Updated keychain secret for'), chalk.cyan(alias));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to update wallet key: ${msg}`));
  } finally {
    if (rl) rl.close();
  }
}

async function listWallets() {
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

async function removeWallet(aliasArg) {
  const rl = !aliasArg ? createInterface() : null;

  try {
    const alias = aliasArg || (await ask(rl, 'Enter alias to remove: '));
    if (!alias) {
      logger.error(chalk.red('Alias is required to remove a wallet.'));
      return;
    }

    const ok = await walletRegistry.deleteWallet(alias);
    if (!ok) {
      logger.error(chalk.yellow('No wallet found with alias:'), chalk.cyan(alias));
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

async function setWalletColor(aliasArg, colorArg) {
  const rl = !aliasArg || !colorArg ? createInterface() : null;

  try {
    const alias = aliasArg || (await ask(rl, 'Enter alias of the wallet to recolor: '));
    if (!alias) {
      logger.error(chalk.red('Alias is required.'));
      return;
    }

    const color =
      colorArg ||
      (await ask(rl, `Enter color (${COLOR_PALETTE.join(', ')}), or blank for default: `));

    const normalized = color ? color.toLowerCase() : null;
    if (normalized && !COLOR_PALETTE.includes(normalized)) {
      logger.error(chalk.red('Invalid color. Must be one of:'), COLOR_PALETTE.join(', '));
      return;
    }

    const ok = await walletRegistry.updateWalletColor(alias, normalized);
    if (!ok) {
      logger.error(chalk.yellow('No wallet found with alias:'), chalk.cyan(alias));
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

async function soloSelectWallet() {
  const selection = await selectWalletInteractively({
    allowOther: true,
    promptLabel: 'Select a wallet:',
  });

  if (!selection || !selection.walletAddress) {
    logger.info(chalk.yellow('No wallet selected.'));
    return;
  }

  const { walletLabel, walletAddress, walletColor } = selection;
  let registryRecord = null;
  if (walletLabel && walletLabel !== 'other') {
    try {
      registryRecord = await walletRegistry.getWalletByAlias(walletLabel);
    } catch (_) {
      registryRecord = null;
    }
  }

  const c = colorizer(walletColor || (registryRecord && registryRecord.color));
  const typeLabel = registryRecord
    ? registryRecord.hasPrivateKey
      ? chalk.bold.green('[SIGNING]')
      : chalk.bold.yellow('[WATCH]')
    : chalk.bold.yellow('[CUSTOM]');

  logger.info('\n');
  logger.info(chalk.bold('Selected wallet:'));
  logger.info('  alias :', c(walletLabel), typeLabel);
  logger.info('  pubkey:', walletAddress);
  logger.info('  color :', walletColor || registryRecord?.color || 'default');
  if (registryRecord) {
    logger.info('  source:', registryRecord.keySource);
  }
}

async function configureWalletOptions() {
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
    logger.info(`  strategy        : ${wallet.strategy || 'none'}`);

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
    const strategy = await promptStrategy(rl, wallet.strategy);

    const updates = {};
    if (usageType !== (wallet.usageType || 'other')) updates.usageType = usageType;
    if (autoAttach !== !!wallet.autoAttachWarchest) updates.autoAttachWarchest = autoAttach;
    if (defaultFunding !== !!wallet.isDefaultFunding) updates.isDefaultFunding = defaultFunding;
    if (strategy !== wallet.strategy) updates.strategy = strategy;

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
    logger.info(`  strategy        : ${updated.strategy || 'none'}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error(chalk.red(`Failed to update wallet options: ${msg}`));
  } finally {
    rl.close();
  }
}

module.exports = {
  COLOR_PALETTE,
  addWalletInteractive,
  listWallets,
  removeWallet,
  setWalletColor,
  soloSelectWallet,
  configureWalletOptions,
  setWalletKeyInteractive,
  colorizer,
  shortenPubkey,
};
