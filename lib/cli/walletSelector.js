'use strict';

/**
 * CLI helper for interactively selecting a wallet from the warchest registry.
 *
 * This module lives in the CLI layer on purpose:
 *  - It depends on readline / process stdio.
 *  - It is concerned with user interaction, not with persistence or BootyBox.
 *
 * The data about wallets (alias, pubkey, color, etc.) continues to be owned by
 * lib/warchest/walletRegistry.js. This module simply presents that data to the
 * user and returns a selection in a consistent shape.
 */

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const logger = require('../logger');
const { getAllWallets } = require('../warchest/walletRegistry');

/**
 * @typedef {Object} WalletSelection
 * @property {string} walletLabel - The human label/alias chosen (or 'other').
 * @property {string} walletAddress - The full base58 wallet address.
 * @property {string|null} walletColor - Optional display color if known.
 */

/**
 * Safely shorten a pubkey for display.
 *
 * @param {string} addr
 * @returns {string}
 */
function shortenPubkey(addr) {
  if (!addr || typeof addr !== 'string') return '';
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/**
 * Render the wallet options list to the logger.
 *
 * @param {Array<Object>} wallets
 * @param {boolean} allowOther
 */
function printWalletOptions(wallets, allowOther) {
  const optionsText = wallets.map(
    (w, idx) => `${idx + 1}) ${w.alias} (${shortenPubkey(w.pubkey)})`,
  );

  if (allowOther) {
    optionsText.push(`${wallets.length + 1}) Other (enter address)`);
  }

  optionsText.forEach((opt) => logger.info(opt));
}

/**
 * Interactively select a wallet from the warchest registry.
 *
 * This is intended for CLI commands (autopsy, tx, etc.) that need a wallet but
 * don't want to duplicate the "list wallets, pick one, or enter custom" flow.
 *
 * @param {Object} [options]
 * @param {string} [options.promptLabel='Which wallet?'] - Label shown before listing wallets.
 * @param {boolean} [options.allowOther=true] - Whether to offer an "Other (enter address)" option.
 * @returns {Promise<WalletSelection>}
 */
async function selectWalletInteractively(options = {}) {
  const {
    promptLabel = 'Which wallet?',
    allowOther = true,
  } = options;

  const rl = readline.createInterface({ input, output });

  try {
    const wallets = (typeof getAllWallets === 'function')
      ? await getAllWallets()
      : [];

    // If there are no wallets in the registry, fall back to "other".
    if (!wallets || wallets.length === 0) {
      logger.warn('[warchest] No wallets found in registry.');
      return {
        walletLabel: 'other',
        walletAddress: '',
        walletColor: null,
      };
    }

    logger.info(promptLabel);
    printWalletOptions(wallets, allowOther);

    let choice = await rl.question('> ');
    choice = choice && choice.trim();

    let walletLabel;
    let walletAddress;
    let walletColor = null;

    const numeric = Number(choice);

    const choiceIsIndex = Number.isInteger(numeric)
      && numeric >= 1
      && numeric <= wallets.length;

    const otherIndex = wallets.length + 1;
    const choiceIsExplicitOther = allowOther
      && Number.isInteger(numeric)
      && numeric === otherIndex;

    if (choiceIsIndex) {
      // User chose one of the listed wallets.
      const selected = wallets[numeric - 1];
      walletLabel = selected.alias;
      walletAddress = selected.pubkey;
      walletColor = selected.color || null;
    } else if (allowOther) {
      // "Other" path: either typed an address directly, or selected the explicit "Other" row.
      if (!choiceIsExplicitOther && choice && choice.length > 0) {
        // Treat the raw input as an address if it looks like one.
        walletAddress = choice;
      }

      if (!walletAddress) {
        walletAddress = await rl.question('Enter wallet address:\n> ');
        walletAddress = walletAddress && walletAddress.trim();
      }

      walletLabel = 'other';
    } else {
      // When "other" is not allowed and the user input is invalid,
      // fall back to the first wallet as a safe default.
      const selected = wallets[0];
      walletLabel = selected.alias;
      walletAddress = selected.pubkey;
      walletColor = selected.color || null;
    }

    return {
      walletLabel,
      walletAddress,
      walletColor,
    };
  } finally {
    rl.close();
  }
}

module.exports = {
  selectWalletInteractively,
};
