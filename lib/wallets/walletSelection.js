'use strict';

/**
 * Wallet selection + prompt helpers used by CLI commands, daemon flows,
 * and any feature that needs to ask the user for a wallet.
 *
 * Centralizing this logic keeps UX consistent and avoids duplicating
 * readline code across lib/cli/walletCli.js, lib/cli/walletSelector.js, etc. and enables an Ink TUI picker.
 */

const readline = require('readline/promises');

const logger = require('../logger');
const walletRegistry = require('./walletRegistry');
const { createWalletResolver } = require('./resolver');

const COLOR_PALETTE = Object.freeze(['green', 'cyan', 'magenta', 'yellow', 'blue']);
const resolver = createWalletResolver();

function isBase58Pubkey(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function pickNextColor(wallets = []) {
  const used = new Set(wallets.map((w) => w.color).filter(Boolean));
  for (const c of COLOR_PALETTE) {
    if (!used.has(c)) return c;
  }
  const idx = wallets.length % COLOR_PALETTE.length;
  return COLOR_PALETTE[idx];
}

async function promptYesNo(rl, question, defaultYes = false) {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
  const raw = await rl.question(question + suffix);
  const s = (raw || '').trim().toLowerCase();
  if (!s) return defaultYes;
  return s === 'y' || s === 'yes';
}

async function promptForAlias(rl) {
  while (true) {
    const raw = await rl.question('Enter wallet alias (e.g. warlord): ');
    const alias = (raw || '').trim();
    if (!alias) {
      logger.error('Alias is required.');
      continue;
    }
    return alias;
  }
}

async function promptForPubkey(rl) {
  while (true) {
    const raw = await rl.question('Enter wallet public key (base58, 32-44 chars): ');
    const pubkey = (raw || '').trim();
    if (!pubkey) {
      logger.error('Public key is required.');
      continue;
    }
    if (!isBase58Pubkey(pubkey)) {
      logger.error('Public key must be a valid base58 address (32-44 chars, no 0/O/I/l).');
      continue;
    }
    return pubkey;
  }
}

async function maybeImportDefaultFundingWallet(rl) {
  logger.warn(
    '[warchest] No default funding wallet configured. A valid funding wallet is required to avoid system failures.'
  );
  logger.info('Tip: run `scoundrel warchest --help` (or -h) for registry commands.');

  const confirm = await promptYesNo(rl, 'Import a default funding wallet now?', true);
  if (!confirm) return null;

  const alias = await promptForAlias(rl);
  const pubkey = await promptForPubkey(rl);

  const existingByAlias = await resolver.getWalletByAlias(alias).catch(() => null);
  const existingByPubkey = await resolver.findWalletByPubkey(pubkey).catch(() => null);
  const existing = existingByAlias || existingByPubkey;

  if (existing) {
    logger.info(
      `[warchest] Using existing wallet ${existing.alias} (${existing.pubkey}) as default funding wallet.`
    );
    await walletRegistry.setDefaultFundingWallet(existing.alias || existing.pubkey);
    return walletRegistry.getDefaultFundingWallet();
  }

  let color = null;
  try {
    const all = await resolver.getAllWallets();
    color = pickNextColor(all);
  } catch (_) {
    color = COLOR_PALETTE[0];
  }

  const hasPrivateKey = await promptYesNo(
    rl,
    'Is this a signing wallet with keys managed securely by the system?',
    false
  );

  const wallet = await walletRegistry.addWallet({
    alias,
    pubkey,
    color,
    usageType: 'funding',
    isDefaultFunding: true,
    autoAttachWarchest: true,
    hasPrivateKey,
    keySource: hasPrivateKey ? 'db_encrypted' : 'none',
    keyRef: null,
  });

  await walletRegistry.setDefaultFundingWallet(alias);
  logger.info(`[warchest] Added ${alias} as default funding wallet.`);

  return wallet;
}

function shortenPubkey(addr) {
  if (!addr || typeof addr !== 'string') return '';
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function printWalletOptions(wallets, allowOther, defaultWallet) {
  const optionsText = wallets.map((w, idx) => {
    const isDefault =
      defaultWallet && defaultWallet.alias === w.alias && defaultWallet.pubkey === w.pubkey;
    const label = isDefault ? `${w.alias} [default]` : w.alias;
    return `${idx + 1}) ${label} (${shortenPubkey(w.pubkey)})`;
  });

  if (allowOther) {
    optionsText.push(`${wallets.length + 1}) Other (enter address)`);
  }

  optionsText.forEach((opt) => logger.info(opt));
}

async function loadInkForWalletPicker() {
  // Ink + ink-text-input are ESM (and may use top-level await), so they must be loaded via dynamic import.
  const ink = await import('ink');
  const inkTextInputMod = await import('ink-text-input');
  const TextInput = inkTextInputMod?.default || inkTextInputMod;
  return { ink, TextInput };
}

async function selectWalletWithInkTui({ wallets, defaultWallet, allowOther, promptLabel }) {
  const { ink, TextInput } = await loadInkForWalletPicker();
  const { render, Box, Text, useApp, useInput } = ink;
  const React = require('react');
  const h = React.createElement;

  return new Promise((resolve, reject) => {
    function WalletPickerApp() {
      const { exit } = useApp();
      const [cursor, setCursor] = React.useState(0);
      const [mode, setMode] = React.useState('list'); // 'list' | 'other'
      const [otherAddr, setOtherAddr] = React.useState('');
      const [status, setStatus] = React.useState('');

      const walletsSafe = Array.isArray(wallets) ? wallets : [];
      const otherIndex = walletsSafe.length; // 0-based cursor position for Other
      const hasOther = !!allowOther;

      // If we have a default wallet and it exists in the list, position cursor there.
      React.useEffect(() => {
        if (!defaultWallet || !walletsSafe.length) return;
        const idx = walletsSafe.findIndex(
          (w) => w.alias === defaultWallet.alias && w.pubkey === defaultWallet.pubkey
        );
        if (idx >= 0) setCursor(idx);
      }, []); // eslint-disable-line react-hooks/exhaustive-deps

      function finalize(result) {
        try {
          resolve(result);
        } finally {
          exit();
        }
      }

      useInput((input, key) => {
        // Global exit
        if (key.escape || input === 'q') {
          finalize({ walletLabel: 'other', walletAddress: '', walletColor: null, cancelled: true });
          return;
        }

        if (mode === 'other') {
          if (input === 'b') {
            setMode('list');
            setStatus('');
            return;
          }
          if (key.return) {
            const addr = (otherAddr || '').trim();
            if (!addr) {
              setStatus('Enter a wallet address.');
              return;
            }
            finalize({ walletLabel: 'other', walletAddress: addr, walletColor: null });
          }
          return;
        }

        // list mode
        if (key.upArrow) {
          setCursor((c) => Math.max(c - 1, 0));
        } else if (key.downArrow) {
          setCursor((c) => {
            const max = hasOther ? walletsSafe.length : Math.max(walletsSafe.length - 1, 0);
            return Math.min(c + 1, max);
          });
        } else if (key.return) {
          if (hasOther && cursor === otherIndex) {
            setMode('other');
            setStatus('');
            return;
          }
          const selected = walletsSafe[cursor];
          if (!selected) {
            setStatus('No wallet selected.');
            return;
          }
          finalize({
            walletLabel: selected.alias,
            walletAddress: selected.pubkey,
            walletColor: selected.color || null,
          });
        }
      });

      function renderList() {
        const rows = walletsSafe.map((w, idx) => {
          const isActive = idx === cursor;
          const isDefault =
            defaultWallet && defaultWallet.alias === w.alias && defaultWallet.pubkey === w.pubkey;
          const label = isDefault ? `${w.alias} [default]` : w.alias;
          const display = `${label} (${shortenPubkey(w.pubkey)})`;
          return h(Text, { key: w.alias, color: isActive ? 'cyan' : undefined }, `${isActive ? '› ' : '  '}${display}`);
        });

        if (hasOther) {
          const isActive = cursor === otherIndex;
          rows.push(
            h(Text, { key: '__other__', color: isActive ? 'cyan' : undefined }, `${isActive ? '› ' : '  '}Other (enter address)`)
          );
        }

        return h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          rows,
          h(Text, { dimColor: true }, 'Use ↑/↓ then Enter. q/Esc to cancel.')
        );
      }

      function renderOther() {
        return h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, 'Enter wallet address:'),
          h(TextInput, { value: otherAddr, onChange: setOtherAddr, focus: true, placeholder: 'base58 address' }),
          h(Text, { dimColor: true }, 'Enter to confirm • b to go back • q/Esc to cancel.')
        );
      }

      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true }, promptLabel || 'Which wallet?'),
        status ? h(Text, { color: 'yellow' }, status) : null,
        mode === 'list' ? renderList() : renderOther()
      );
    }

    try {
      const { waitUntilExit } = render(h(WalletPickerApp));
      waitUntilExit().catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function loadWalletsForSelection() {
  let wallets = [];

  try {
    wallets = await resolver.listFundingWallets();
  } catch (err) {
    logger.debug && logger.debug('[walletSelection] listFundingWallets failed:', err);
  }

  if (!wallets || wallets.length === 0) {
    try {
      wallets = await resolver.getAllWallets();
    } catch (err) {
      logger.debug && logger.debug('[walletSelection] getAllWallets failed:', err);
      wallets = [];
    }
  }

  let defaultWallet = null;
  try {
    defaultWallet = await resolver.getDefaultFundingWallet();
  } catch (err) {
    logger.debug && logger.debug('[walletSelection] getDefaultFundingWallet failed:', err);
  }

  if (!defaultWallet) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      defaultWallet = await maybeImportDefaultFundingWallet(rl);
      if (defaultWallet) {
        wallets = await resolver.getAllWallets();
      }
    } catch (err) {
      logger.warn('[walletSelection] Skipping default funding import:', err?.message || err);
    } finally {
      rl.close();
    }
  }

  if (defaultWallet && wallets && wallets.length > 0) {
    const idx = wallets.findIndex(
      (w) => w.alias === defaultWallet.alias && w.pubkey === defaultWallet.pubkey
    );
    if (idx > 0) {
      const [df] = wallets.splice(idx, 1);
      wallets.unshift(df);
    } else if (idx === -1) {
      wallets.unshift(defaultWallet);
    }
  }

  return { wallets, defaultWallet: defaultWallet || null };
}

/**
 * Interactively select a wallet from the registry, optionally allowing a
 * custom address entry. Returns metadata needed by CLI commands.
 *
 * @param {Object} [options]
 * @param {string} [options.promptLabel='Which wallet?']
 * @param {boolean} [options.allowOther=true]
 * @param {readline.Interface} [options.rl] Optional readline instance for testing
 * @param {boolean} [options.tui] If true, prefer Ink TUI; if false, force readline. Default: auto when in a TTY.
 * @param {boolean} [options.allowTui=true] Set false to disable Ink even when TTY.
 * @returns {Promise<{walletLabel: string, walletAddress: string, walletColor: string|null}>}
 */
async function selectWalletInteractively(options = {}) {
  const {
    promptLabel = 'Which wallet?',
    allowOther = true,
    rl: injectedRl,
    tui,
    allowTui = true,
  } = options;

  const rl =
    injectedRl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  try {
    const { wallets, defaultWallet } = await loadWalletsForSelection();

    // Prefer Ink TUI in real terminals unless explicitly disabled or when using an injected readline (tests).
    const isTty = !!process.stdout.isTTY && !!process.stdin.isTTY;
    const useTui = allowTui && isTty && !injectedRl && tui !== false;

    if (useTui) {
      return await selectWalletWithInkTui({
        wallets,
        defaultWallet,
        allowOther,
        promptLabel,
      });
    }

    if (!wallets || wallets.length === 0) {
      logger.warn('[warchest] No wallets found in registry.');
      return {
        walletLabel: 'other',
        walletAddress: '',
        walletColor: null,
      };
    }

    logger.info(promptLabel);
    printWalletOptions(wallets, allowOther, defaultWallet);

    let choice = await rl.question('> ');
    choice = choice && choice.trim();

    let walletLabel;
    let walletAddress;
    let walletColor = null;

    const numeric = Number(choice);

    const choiceIsIndex =
      Number.isInteger(numeric) && numeric >= 1 && numeric <= wallets.length;

    const otherIndex = wallets.length + 1;
    const choiceIsExplicitOther =
      allowOther && Number.isInteger(numeric) && numeric === otherIndex;

    if (choiceIsIndex) {
      const selected = wallets[numeric - 1];
      walletLabel = selected.alias;
      walletAddress = selected.pubkey;
      walletColor = selected.color || null;
    } else if (allowOther) {
      if (!choiceIsExplicitOther && choice && choice.length > 0) {
        walletAddress = choice;
      }

      if (!walletAddress) {
        walletAddress = await rl.question('Enter wallet address:\n> ');
        walletAddress = walletAddress && walletAddress.trim();
      }

      walletLabel = 'other';
    } else {
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
    if (!injectedRl) {
      rl.close();
    }
  }
}

module.exports = {
  COLOR_PALETTE,
  isBase58Pubkey,
  pickNextColor,
  selectWalletInteractively,
  maybeImportDefaultFundingWallet,
  selectWalletWithInkTui,
};
