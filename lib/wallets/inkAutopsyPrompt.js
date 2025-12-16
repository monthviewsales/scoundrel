'use strict';

const React = require('react');
const { Box, Text, useApp, useInput } = require('ink');
const TextInput = require('ink-text-input').default;

const walletRegistry = require('./walletRegistry');
const { colorizer, shortenPubkey } = require('./walletManagement');

const h = React.createElement;

function isBase58Address(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function useWallets(registry) {
  const [wallets, setWallets] = React.useState([]);
  const [error, setError] = React.useState('');

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

  return { wallets, error };
}

/**
 * Ink prompt for selecting a wallet + mint before running autopsy.
 *
 * @param {Object} props
 * @param {Function} props.onSubmit Callback invoked with { walletLabel, walletAddress, mint }
 * @param {Object} [props.registry] Optional registry implementation (injected for tests)
 * @param {string} [props.defaultMint] Optional pre-filled mint
 * @returns {React.ReactElement}
 */
function AutopsyPrompt({ onSubmit, registry = walletRegistry, defaultMint = '' }) {
  const { exit } = useApp();
  const { wallets, error } = useWallets(registry);
  const [stage, setStage] = React.useState(wallets.length ? 'walletList' : 'manualWallet');
  const [walletIdx, setWalletIdx] = React.useState(0);
  const [walletLabel, setWalletLabel] = React.useState('');
  const [walletAddress, setWalletAddress] = React.useState('');
  const [mint, setMint] = React.useState(defaultMint);
  const [status, setStatus] = React.useState('');

  React.useEffect(() => {
    if (wallets.length && stage === 'walletList') {
      setWalletIdx(0);
    }
  }, [wallets, stage]);

  useInput((input, key) => {
    if (key.escape) {
      exit();
      return;
    }
    if (stage === 'walletList') {
      if (key.upArrow) setWalletIdx((prev) => Math.max(prev - 1, 0));
      if (key.downArrow) setWalletIdx((prev) => Math.min(prev + 1, wallets.length));
      if (key.return) {
        const isManual = walletIdx === wallets.length;
        if (isManual) {
          setStage('manualWallet');
          return;
        }
        const wallet = wallets[walletIdx];
        if (wallet) {
          setWalletLabel(wallet.alias);
          setWalletAddress(wallet.pubkey);
          setStage('mint');
        }
      }
    }
  });

  async function handleSubmit() {
    if (!walletAddress.trim()) {
      setStatus('Wallet address is required');
      return;
    }
    if (!mint.trim()) {
      setStatus('Mint is required');
      return;
    }
    setStatus('');
    try {
      await onSubmit({
        walletLabel: walletLabel || walletAddress,
        walletAddress: walletAddress.trim(),
        mint: mint.trim(),
      });
      exit();
    } catch (err) {
      setStatus(err?.message || String(err));
    }
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, 'Autopsy prompt'),
    error ? h(Text, { color: 'red' }, error) : null,
    stage === 'walletList'
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, 'Select a wallet (↑/↓, Enter). Last entry is manual.'),
          wallets.map((w, idx) => {
            const active = idx === walletIdx;
            const c = colorizer(w.color);
            return h(
              Text,
              { key: w.alias, color: active ? 'cyan' : undefined },
              `${active ? '› ' : '  '}${c(w.alias)} (${shortenPubkey(w.pubkey)})`
            );
          }),
          h(Text, { color: walletIdx === wallets.length ? 'cyan' : undefined }, `${wallets.length ? '' : '› '}Other (manual address)`)
        )
      : null,
    stage === 'manualWallet'
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, 'Enter wallet address (base58):'),
          h(TextInput, { value: walletAddress, onChange: setWalletAddress, placeholder: 'wallet pubkey' }),
          h(Text, null, 'Alias/label (optional):'),
          h(TextInput, { value: walletLabel, onChange: setWalletLabel, placeholder: 'alias' }),
          h(Text, { dimColor: true }, 'Press Enter after mint to submit.'),
          h(
            Box,
            { marginTop: 1 },
            h(Text, null, 'Mint to analyze:'),
            h(TextInput, { value: mint, onChange: setMint, onSubmit: handleSubmit, placeholder: 'mint' })
          )
        )
      : null,
    stage === 'mint'
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, `Wallet: ${walletLabel || wallets[walletIdx]?.alias} (${shortenPubkey(walletAddress)})`),
          h(Text, null, 'Mint to analyze:'),
          h(TextInput, { value: mint, onChange: setMint, onSubmit: handleSubmit, placeholder: 'mint' })
        )
      : null,
    stage !== 'walletList' && !isBase58Address(walletAddress) && walletAddress.length > 0
      ? h(Text, { color: 'yellow' }, 'Wallet address does not look like base58.')
      : null,
    !isBase58Address(mint) && mint.length > 0 ? h(Text, { color: 'yellow' }, 'Mint does not look like base58.') : null,
    h(
      Box,
      { marginTop: 1 },
      h(Text, { dimColor: true }, 'Press Esc to exit.')
    ),
    h(Text, { color: 'yellow' }, status)
  );
}

module.exports = {
  AutopsyPrompt,
};
