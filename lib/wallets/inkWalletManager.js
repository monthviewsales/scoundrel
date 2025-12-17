'use strict';

const React = require('react');
const { Box, Text, useApp, useInput } = require('ink');
const TextInput = require('ink-text-input').default;

const walletRegistry = require('./walletRegistry');
const walletOptions = require('./optionsManager');
const { COLOR_PALETTE, pickNextColor, colorizer, shortenPubkey } = require('./walletManagement');

const h = React.createElement;

const MENU_OPTIONS = [
  { key: 'add', label: 'Add wallet' },
  { key: 'list', label: 'List wallets' },
  { key: 'color', label: 'Set wallet colour' },
  { key: 'options', label: 'Configure options' },
  { key: 'remove', label: 'Remove wallet' },
  { key: 'solo', label: 'Solo select wallet' },
  { key: 'exit', label: 'Exit' },
];

function useWallets(registry) {
  const [wallets, setWallets] = React.useState([]);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let mounted = true;
    registry
      .getAllWallets()
      .then((result) => {
        if (mounted) setWallets(result || []);
      })
      .catch((err) => setError(err?.message || String(err)));
    return () => {
      mounted = false;
    };
  }, [registry]);

  return { wallets, setWallets, error };
}

function Menu({ options, cursor, onSelect }) {
  useInput((input, key) => {
    if (key.upArrow) {
      onSelect(Math.max(cursor - 1, 0), false);
    } else if (key.downArrow) {
      onSelect(Math.min(cursor + 1, options.length - 1), false);
    } else if (key.return) {
      onSelect(cursor, true);
    }
  });

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    options.map((opt, idx) => {
      const isActive = idx === cursor;
      return h(
        Text,
        { key: opt.key, color: isActive ? 'cyan' : undefined },
        `${isActive ? '› ' : '  '}${opt.label}`
      );
    })
  );
}

function StatusLine({ message }) {
  if (!message) return null;
  return h(
    Box,
    { marginTop: 1 },
    h(Text, { color: 'yellow' }, message)
  );
}

function WalletList({ wallets, onExit }) {
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'b') {
      onExit();
    }
  });

  if (!wallets || wallets.length === 0) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'yellow' }, 'No wallets found. Press b to go back.')
    );
  }

  return h(
    Box,
    { flexDirection: 'column' },
    wallets.map((w) => {
      const c = colorizer(w.color);
      const typeLabel = w.hasPrivateKey ? '[SIGNING]' : '[WATCH]';
      return h(
        Box,
        { key: w.alias, flexDirection: 'column', marginBottom: 1 },
        h(Text, null, `${c(w.alias)} ${typeLabel} (${shortenPubkey(w.pubkey)})`),
        h(Text, { dimColor: true }, `colour: ${w.color || 'default'} • source: ${w.keySource || 'unknown'}`)
      );
    }),
    h(Text, { dimColor: true }, 'Press b to return to the main menu.')
  );
}

function AddWalletForm({ registry, existingWallets, onAdded, onCancel }) {
  const [pubkey, setPubkey] = React.useState('');
  const [alias, setAlias] = React.useState('');
  const [isSigning, setIsSigning] = React.useState(false);
  const [error, setError] = React.useState('');
  const [stage, setStage] = React.useState('pubkey');
  const [busy, setBusy] = React.useState(false);

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onCancel();
    }
    if (stage === 'type' && (input === 's' || input === 'w')) {
      setIsSigning(input === 's');
    }
  });

  const color = pickNextColor(existingWallets);

  async function handleSubmit() {
    if (!pubkey.trim()) {
      setError('Public key is required.');
      return;
    }
    if (!alias.trim()) {
      setError('Alias is required.');
      return;
    }
    setBusy(true);
    try {
      const created = await registry.addWallet({
        alias: alias.trim(),
        pubkey: pubkey.trim(),
        color,
        hasPrivateKey: isSigning,
        keySource: 'none',
        keyRef: null,
      });
      onAdded(created);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'Enter wallet public key:'),
    h(TextInput, {
      value: pubkey,
      onChange: setPubkey,
      onSubmit: () => setStage('alias'),
      placeholder: 'base58 pubkey',
    }),
    stage !== 'pubkey'
      ? h(
          Box,
          { marginTop: 1, flexDirection: 'column' },
          h(Text, null, 'Enter alias:'),
          h(TextInput, {
            value: alias,
            onChange: setAlias,
            onSubmit: () => setStage('type'),
            placeholder: 'alias',
          })
        )
      : null,
    stage === 'type'
      ? h(
          Box,
          { marginTop: 1, flexDirection: 'column' },
          h(Text, null, `Wallet type: ${isSigning ? 'Signing' : 'Watch-only'} (press "s" for signing, "w" for watch)`),
          h(Text, { dimColor: true }, `Next colour: ${color || 'default'}`),
          h(
            Box,
            { marginTop: 1 },
            h(Text, { color: 'green', dimColor: busy }, 'Press enter to save')
          )
        )
      : null,
    stage === 'type'
      ? h(
          Box,
          { marginTop: 1 },
          h(
            Text,
            null,
            h(Text, { color: 'cyan' }, '› '),
            h(Text, { underline: true, onPress: handleSubmit }, 'Save wallet')
          )
        )
      : null,
    stage === 'type'
      ? h(
          Box,
          { marginTop: 1 },
          h(Text, { color: 'yellow' }, 'Press b to cancel')
        )
      : null,
    h(StatusLine, { message: busy ? 'Saving…' : error })
  );
}

function ColorChooser({ wallets, registry, onUpdated, onCancel }) {
  const [walletIdx, setWalletIdx] = React.useState(0);
  const [colorIdx, setColorIdx] = React.useState(0);
  const [status, setStatus] = React.useState('');

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onCancel();
      return;
    }
    if (key.leftArrow) {
      setColorIdx((prev) => (prev - 1 + COLOR_PALETTE.length) % COLOR_PALETTE.length);
    } else if (key.rightArrow) {
      setColorIdx((prev) => (prev + 1) % COLOR_PALETTE.length);
    } else if (key.upArrow) {
      setWalletIdx((prev) => Math.max(prev - 1, 0));
    } else if (key.downArrow) {
      setWalletIdx((prev) => Math.min(prev + 1, wallets.length - 1));
    } else if (key.return) {
      handleSave();
    }
  });

  const wallet = wallets[walletIdx];
  const color = COLOR_PALETTE[colorIdx];

  async function handleSave() {
    if (!wallet) return;
    try {
      await registry.updateWalletColor(wallet.alias, color);
      setStatus(`Updated ${wallet.alias} to ${color}`);
      onUpdated(wallet.alias, color);
    } catch (err) {
      setStatus(err?.message || String(err));
    }
  }

  if (!wallets.length) {
    return h(Text, { color: 'yellow' }, 'No wallets available. Press b to go back.');
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'Pick a wallet (↑/↓) and colour (←/→). Enter to save.'),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      wallets.map((w, idx) => {
        const active = idx === walletIdx;
        const c = colorizer(w.color);
        return h(
          Text,
          { key: w.alias, color: active ? 'cyan' : undefined },
          `${active ? '› ' : '  '}${c(w.alias)} (${shortenPubkey(w.pubkey)})`
        );
      })
    ),
    h(
      Box,
      { marginTop: 1 },
      h(Text, null, 'Colour: ', h(Text, { color }, color))
    ),
    h(StatusLine, { message: status }),
    h(Text, { dimColor: true }, 'Press b to return to menu.')
  );
}

function OptionsEditor({ wallets, onUpdated, onCancel }) {
  const [walletIdx, setWalletIdx] = React.useState(0);
  const [usageIdx, setUsageIdx] = React.useState(0);
  const [autoAttach, setAutoAttach] = React.useState(false);
  const [defaultFunding, setDefaultFunding] = React.useState(false);
  const [strategyId, setStrategyId] = React.useState('');
  const [stage, setStage] = React.useState('pick');
  const [status, setStatus] = React.useState('');

  React.useEffect(() => {
    const wallet = wallets[walletIdx];
    if (wallet) {
      setUsageIdx(Math.max(walletOptions.USAGE_TYPES.indexOf(wallet.usageType || 'other'), 0));
      setAutoAttach(!!wallet.autoAttachWarchest);
      setDefaultFunding(!!wallet.isDefaultFunding);
      setStrategyId(wallet.strategyId || '');
      setStage('edit');
    }
  }, [walletIdx, wallets]);

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onCancel();
      return;
    }
    if (!wallets.length) return;
    if (stage === 'pick') return;
    if (key.leftArrow) {
      setUsageIdx((prev) => (prev - 1 + walletOptions.USAGE_TYPES.length) % walletOptions.USAGE_TYPES.length);
    } else if (key.rightArrow) {
      setUsageIdx((prev) => (prev + 1) % walletOptions.USAGE_TYPES.length);
    } else if (input === 'a') {
      setAutoAttach((prev) => !prev);
    } else if (input === 'd') {
      setDefaultFunding((prev) => !prev);
    } else if (key.upArrow) {
      setWalletIdx((prev) => Math.max(prev - 1, 0));
    } else if (key.downArrow) {
      setWalletIdx((prev) => Math.min(prev + 1, wallets.length - 1));
    } else if (key.return) {
      handleSave();
    }
  });

  async function handleSave() {
    const wallet = wallets[walletIdx];
    if (!wallet) return;
    try {
      const updates = {
        usageType: walletOptions.USAGE_TYPES[usageIdx],
        autoAttachWarchest: autoAttach,
        isDefaultFunding: defaultFunding,
        strategyId: strategyId || null,
      };
      await walletOptions.updateWalletOptions(wallet.alias, updates);
      setStatus(`Updated ${wallet.alias}`);
      onUpdated(wallet.alias, updates);
    } catch (err) {
      setStatus(err?.message || String(err));
    }
  }

  if (!wallets.length) {
    return h(Text, { color: 'yellow' }, 'No wallets available. Press b to go back.');
  }

  const wallet = wallets[walletIdx];
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'Select wallet (↑/↓). Toggle a=auto-attach, d=default funding. Enter to save.'),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      wallets.map((w, idx) => {
        const active = idx === walletIdx;
        const c = colorizer(w.color);
        return h(
          Text,
          { key: w.alias, color: active ? 'cyan' : undefined },
          `${active ? '› ' : '  '}${c(w.alias)} (${shortenPubkey(w.pubkey)})`
        );
      })
    ),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      h(
        Text,
        null,
        'Usage: ',
        h(Text, { color: 'green' }, walletOptions.USAGE_TYPES[usageIdx]),
        ' (←/→)'
      ),
      h(Text, null, `Auto-attach HUD (a): ${autoAttach ? 'yes' : 'no'}`),
      h(Text, null, `Default funding (d): ${defaultFunding ? 'yes' : 'no'}`),
      h(
        Text,
        null,
        'Strategy ID:',
        ' ',
        h(TextInput, { value: strategyId, onChange: setStrategyId })
      )
    ),
    h(StatusLine, { message: status }),
    h(Text, { dimColor: true }, 'Press b to return to menu.')
  );
}

function RemovalPrompt({ wallets, registry, onRemoved, onCancel }) {
  const [walletIdx, setWalletIdx] = React.useState(0);
  const [status, setStatus] = React.useState('');

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onCancel();
      return;
    }
    if (!wallets.length) return;
    if (key.upArrow) setWalletIdx((prev) => Math.max(prev - 1, 0));
    if (key.downArrow) setWalletIdx((prev) => Math.min(prev + 1, wallets.length - 1));
    if (key.return) handleRemove();
  });

  async function handleRemove() {
    const wallet = wallets[walletIdx];
    if (!wallet) return;
    try {
      await registry.deleteWallet(wallet.alias);
      setStatus(`Removed ${wallet.alias}`);
      onRemoved(wallet.alias);
    } catch (err) {
      setStatus(err?.message || String(err));
    }
  }

  if (!wallets.length) return h(Text, { color: 'yellow' }, 'No wallets available.');

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'Select wallet to remove (↑/↓, Enter). Press b to cancel.'),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      wallets.map((w, idx) => {
        const active = idx === walletIdx;
        const c = colorizer(w.color);
        return h(Text, { key: w.alias, color: active ? 'red' : undefined }, `${active ? '› ' : '  '}${c(w.alias)}`);
      })
    ),
    h(StatusLine, { message: status })
  );
}

function SoloSelector({ wallets, onSelect, onCancel }) {
  const [walletIdx, setWalletIdx] = React.useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onCancel();
      return;
    }
    if (!wallets.length) return;
    if (key.upArrow) setWalletIdx((prev) => Math.max(prev - 1, 0));
    if (key.downArrow) setWalletIdx((prev) => Math.min(prev + 1, wallets.length - 1));
    if (key.return) {
      const wallet = wallets[walletIdx];
      if (wallet) onSelect(wallet);
    }
  });

  if (!wallets.length) return h(Text, { color: 'yellow' }, 'No wallets available for solo mode.');

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'Select wallet (↑/↓, Enter). Press b to cancel.'),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      wallets.map((w, idx) => {
        const active = idx === walletIdx;
        const c = colorizer(w.color);
        const typeLabel = w.hasPrivateKey ? '[SIGNING]' : '[WATCH]';
        return h(
          Text,
          { key: w.alias, color: active ? 'cyan' : undefined },
          `${active ? '› ' : '  '}${c(w.alias)} ${typeLabel} (${shortenPubkey(w.pubkey)})`
        );
      })
    )
  );
}

function Heading({ children }) {
  return h(
    Box,
    { marginBottom: 1 },
    h(Text, { bold: true }, children)
  );
}

/**
 * Ink wallet manager app used by CLI commands.
 *
 * @param {Object} props
 * @param {string} [props.initialRoute]  Optional route to open (e.g. 'solo').
 * @param {Object} [props.registry]      Wallet registry implementation.
 * @param {Function} [props.onComplete]  Called when the app requests exit.
 * @returns {React.ReactElement}
 */
function WalletManagerApp({ initialRoute = 'menu', registry = walletRegistry, onComplete }) {
  const { exit } = useApp();
  const { wallets, setWallets, error } = useWallets(registry);
  const [route, setRoute] = React.useState(initialRoute);
  const [cursor, setCursor] = React.useState(0);
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (route === 'exit') {
      onComplete && onComplete();
      exit();
    }
  }, [route, exit, onComplete]);

  function refreshWallets() {
    registry
      .getAllWallets()
      .then((next) => setWallets(next || []))
      .catch((err) => setMessage(err?.message || String(err)));
  }

  function handleMenuSelect(idx, confirmed) {
    setCursor(idx);
    if (!confirmed) return;
    setRoute(MENU_OPTIONS[idx].key);
  }

  function updateRoute(nextRoute, status) {
    setRoute(nextRoute);
    if (status) setMessage(status);
  }

  if (route === 'list') {
    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Your wallets'),
      h(WalletList, { wallets, onExit: () => setRoute('menu') })
    );
  }

  if (route === 'add') {
    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Add a wallet'),
      h(AddWalletForm, {
        registry,
        existingWallets: wallets,
        onAdded: (wallet) => {
          setMessage(`Added ${wallet.alias}`);
          refreshWallets();
          updateRoute('menu');
        },
        onCancel: () => updateRoute('menu'),
      }),
      h(StatusLine, { message })
    );
  }

  if (route === 'color') {
    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Set wallet colour'),
      h(ColorChooser, {
        wallets,
        registry,
        onUpdated: (alias) => {
          setMessage(`Updated ${alias}`);
          refreshWallets();
        },
        onCancel: () => updateRoute('menu'),
      })
    );
  }

  if (route === 'options') {
    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Configure wallet options'),
      h(OptionsEditor, {
        wallets,
        onUpdated: (alias) => {
          setMessage(`Updated ${alias}`);
          refreshWallets();
        },
        onCancel: () => updateRoute('menu'),
      })
    );
  }

  if (route === 'remove') {
    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Remove a wallet'),
      h(RemovalPrompt, {
        wallets,
        registry,
        onRemoved: (alias) => {
          setMessage(`Removed ${alias}`);
          refreshWallets();
          updateRoute('menu');
        },
        onCancel: () => updateRoute('menu'),
      })
    );
  }

  if (route === 'solo') {
    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Solo wallet picker'),
      h(SoloSelector, {
        wallets,
        onSelect: (wallet) => {
          const c = colorizer(wallet.color);
          setMessage(`Solo wallet: ${c(wallet.alias)} (${wallet.pubkey})`);
          onComplete && onComplete(wallet);
          exit();
        },
        onCancel: () => updateRoute('menu'),
      }),
      h(StatusLine, { message })
    );
  }

  return h(
    React.Fragment,
    null,
    h(Heading, null, 'Wallet manager'),
    error ? h(Text, { color: 'red' }, error) : null,
    h(Menu, { options: MENU_OPTIONS, cursor, onSelect: handleMenuSelect }),
    h(StatusLine, { message: message || 'Use ↑/↓ to navigate, Enter to select.' })
  );
}

module.exports = {
  WalletManagerApp,
};
