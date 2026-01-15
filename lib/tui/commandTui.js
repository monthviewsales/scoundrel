'use strict';

const fs = require('fs');
const React = require('react');

const { createFrameComponents } = require('./components/frame');
const { createSpinnerComponent } = require('./components/spinner');
const { createProgressBarComponent } = require('./components/progressBar');
const { createSelectListComponent } = require('./components/selectList');
const { createEventLogComponent } = require('./components/eventLog');
const { createEventBus } = require('./eventBus');
const { shortenAddress } = require('./formatting');
const { resolveMintCandidates } = require('./lookup/mintLookup');
const { loadWalletMatches } = require('./lookup/walletLookup');
const { createHubEventFollower, DEFAULT_HUD_STATE_PATH } = require('../warchest/events');
const { summarizeHubEvent } = require('../warchest/hudEvents');
const { ensureBootyBoxInit } = require('../bootyBoxInit');
const BootyBox = require('../../db');
const walletRegistry = require('../wallets/walletRegistry');
const { pickNextColor, isBase58Pubkey } = require('../wallets/walletSelection');

function readJson(path, fallback) {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function clearScreen() {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write('\x1b[2J\x1b[H');
  } catch (_) {
    // ignore terminal write failures
  }
}

function captureConsole(onLine) {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const forward = (args) => {
    if (typeof onLine !== 'function') return;
    const text = args.map((part) => {
      if (typeof part === 'string') return part;
      try {
        return JSON.stringify(part);
      } catch (_) {
        return String(part);
      }
    }).join(' ');
    onLine(text);
  };

  console.log = (...args) => forward(args);
  console.info = (...args) => forward(args);
  console.warn = (...args) => forward(args);
  console.error = (...args) => forward(args);
  console.debug = (...args) => forward(args);

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  };
}

function formatLogArgs(args) {
  return (args || [])
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part instanceof Error) return part.stack || part.message || String(part);
      try {
        return JSON.stringify(part);
      } catch (_) {
        return String(part);
      }
    })
    .join(' ');
}

function captureLogger(bus) {
  let logger;
  try {
    logger = require('../logger');
  } catch (_) {
    logger = null;
  }
  if (!logger || typeof logger !== 'object') return () => {};

  const levels = ['debug', 'info', 'warn', 'error'];
  const originals = {};

  const wrap = (target, level) => {
    const original = target[level];
    if (typeof original !== 'function') return;
    originals[`${level}:${target === logger ? 'root' : 'child'}`] = original;
    target[level] = (...args) => {
      if (bus) {
        const text = formatLogArgs(args);
        bus.emit({ text: `[${level}] ${text}` });
      }
      return original(...args);
    };
  };

  levels.forEach((level) => wrap(logger, level));

  const originalChild = typeof logger.child === 'function' ? logger.child : null;
  if (originalChild) {
    logger.child = (...args) => {
      const child = originalChild(...args);
      if (child && typeof child === 'object') {
        levels.forEach((level) => wrap(child, level));
      }
      return child;
    };
  }

  return () => {
    levels.forEach((level) => {
      const key = `${level}:root`;
      if (Object.prototype.hasOwnProperty.call(originals, key)) {
        logger[level] = originals[key];
      }
    });
    if (originalChild) {
      logger.child = originalChild;
    }
  };
}

function formatMintLabel(candidate) {
  if (!candidate) return '';
  const mint = candidate.mint || '';
  const symbol = candidate.symbol || '';
  const name = candidate.name || '';
  const label = symbol || name || mint;
  return `${label} (${shortenAddress(mint)})`;
}

function formatWalletLabel(wallet, solBalance) {
  if (!wallet) return '';
  const suffix = Number.isFinite(solBalance) ? ` ${solBalance.toFixed(3)} SOL` : '';
  return `${wallet.alias || wallet.pubkey}${suffix}`;
}

function formatSwapProgress(payload) {
  if (!payload) return 'progress';
  const normalized = payload.payload && typeof payload.payload === 'object'
    ? payload.payload
    : payload.data && typeof payload.data === 'object'
      ? payload.data
      : payload;
  const event =
    normalized.event ||
    normalized.step ||
    normalized.status ||
    normalized.name ||
    payload.event ||
    payload.step ||
    payload.status ||
    payload.name ||
    null;
  if (!event) return 'progress';
  switch (event) {
    case 'swap.build.start':
      return 'Preparing swap';
    case 'swap.build.done':
      return 'Swap built';
    case 'swap.send.start':
      return 'Submitting transaction';
    case 'swap.send.done':
      return 'Transaction submitted';
    case 'swap:validated':
      return 'Validated request';
    case 'swap:secret:resolved':
      return 'Wallet key resolved';
    case 'swap:amount:resolve:start':
      return 'Resolving amount';
    case 'swap:amount:resolve:done':
      return 'Amount resolved';
    case 'swap:engine:start':
      return 'Preparing swap';
    case 'swap:submitted':
      return 'Transaction submitted';
    case 'swap:monitor:start':
      return 'Confirming transaction';
    case 'swap:monitor:done':
      return 'Confirmation complete';
    case 'swap:monitor:detached':
      return 'Monitor detached (background)';
    default:
      return String(event);
  }
}

/**
 * Factory for the command TUI.
 *
 * @param {object} ink
 * @param {Function} TextInput
 * @returns {{ CommandTuiApp: Function }}
 */
function createCommandTuiComponents(ink, TextInput) {
  const { Box, Text, useInput, useApp } = ink;
  const h = React.createElement;
  const { Header, Footer, Panel } = createFrameComponents(ink);
  const { Spinner } = createSpinnerComponent(ink);
  const { ProgressBar } = createProgressBarComponent(ink);
  const { SelectList } = createSelectListComponent(ink);
  const { EventLog } = createEventLogComponent(ink);
  const { createTxSummaryCardComponents } = require('./txSummaryCard');
  const { TxSummaryCard } = createTxSummaryCardComponents(ink);

  function useEventLog(bus) {
    const [events, setEvents] = React.useState([]);
    React.useEffect(() => {
      if (!bus) return () => {};
      return bus.on((event) => {
        const text =
          event && typeof event === 'object'
            ? event.text || event.message || JSON.stringify(event)
            : String(event);
        setEvents((prev) => {
          const next = [{ text }, ...prev];
          if (next.length > 8) next.length = 8;
          return next;
        });
      });
    }, [bus]);
    return events;
  }

  function MintLookupPanel({ label, initialQuery, onSelect, onCancel, bus }) {
    const [query, setQuery] = React.useState(initialQuery || '');
    const [status, setStatus] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [matches, setMatches] = React.useState([]);
    const [mode, setMode] = React.useState('input');
    const [searched, setSearched] = React.useState(false);

    useInput((input, key) => {
      if (key.escape || input === 'q') {
        if (typeof onCancel === 'function') onCancel();
      }
    });

    async function runSearch(searchQuery) {
      const nextQuery = String(searchQuery || '').trim();
      if (!nextQuery) {
        setStatus('Enter a mint or symbol.');
        return;
      }
      setLoading(true);
      setStatus('Searching...');
      let result;
      try {
        result = await resolveMintCandidates(nextQuery);
      } catch (err) {
        setLoading(false);
        setStatus(err?.message || 'Lookup failed.');
        return;
      }
      setLoading(false);
      setSearched(true);
      if (!result.matches.length) {
        if (nextQuery.length < 4) {
          setStatus('No DB matches. Enter 4+ chars to enable API search.');
        } else {
          setStatus('No matches found.');
        }
        setMode('input');
        return;
      }
      if (result.matches.length === 1) {
        if (bus) bus.emit({ text: `Selected mint ${formatMintLabel(result.matches[0])}` });
        onSelect(result.matches[0]);
        return;
      }
      setMatches(result.matches);
      setMode('select');
      setStatus(`Select a mint (${result.source})`);
    }

    React.useEffect(() => {
      if (searched || !initialQuery) return;
      setSearched(true);
      runSearch(initialQuery);
    }, [initialQuery, searched]);

    if (mode === 'select') {
      const items = matches.map((item) => ({
        key: item.mint,
        label: formatMintLabel(item),
        description: item.name && item.symbol ? item.name : null,
        value: item,
      }));
      return h(SelectList, {
        items,
        title: status || label || 'Select mint',
        hint: 'Use arrows and Enter. Press b to go back.',
        onSelect: (item) => {
          onSelect(item.value || item);
        },
        onCancel: () => {
          setMode('input');
        },
      });
    }

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, label || 'Enter mint or symbol:'),
      h(TextInput, {
        value: query,
        onChange: setQuery,
        onSubmit: runSearch,
        placeholder: 'mint or symbol',
      }),
      loading ? h(Spinner, { label: 'Searching' }) : null,
      status ? h(Text, { dimColor: true }, status) : null
    );
  }

  function WalletLookupPanel({ label, initialQuery, onSelect, onCancel }) {
    const [query, setQuery] = React.useState(initialQuery || '');
    const [status, setStatus] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [matches, setMatches] = React.useState([]);
    const [mode, setMode] = React.useState('input');
    const [searched, setSearched] = React.useState(false);

    useInput((input, key) => {
      if (key.escape || input === 'q') {
        if (typeof onCancel === 'function') onCancel();
      }
    });

    async function runSearch(searchQuery) {
      const nextQuery = String(searchQuery || '').trim();
      setLoading(true);
      setStatus('Searching...');
      let results;
      try {
        results = await loadWalletMatches(nextQuery);
      } catch (err) {
        setLoading(false);
        setStatus(err?.message || 'Lookup failed.');
        return;
      }
      setLoading(false);
      setSearched(true);
      if (!results.length) {
        setStatus('No wallets found.');
        setMode('input');
        return;
      }
      if (results.length === 1) {
        onSelect(results[0]);
        return;
      }
      setMatches(results);
      setMode('select');
      setStatus('Select a wallet');
    }

    React.useEffect(() => {
      if (searched || !initialQuery) return;
      setSearched(true);
      runSearch(initialQuery);
    }, [initialQuery, searched]);

    if (mode === 'select') {
      const items = matches.map((wallet) => ({
        key: wallet.alias || wallet.pubkey,
        label: wallet.alias || wallet.pubkey,
        description: shortenAddress(wallet.pubkey),
        value: wallet,
      }));
      return h(SelectList, {
        items,
        title: status || label || 'Select wallet',
        hint: 'Use arrows and Enter. Press b to go back.',
        onSelect: (item) => onSelect(item.value || item),
        onCancel: () => setMode('input'),
      });
    }

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, label || 'Enter wallet alias or address:'),
      h(TextInput, {
        value: query,
        onChange: setQuery,
        onSubmit: runSearch,
        placeholder: 'alias or address',
      }),
      loading ? h(Spinner, { label: 'Searching' }) : null,
      status ? h(Text, { dimColor: true }, status) : null
    );
  }

  function AddWalletPanel({ onAdded, onCancel, bus }) {
    const [pubkey, setPubkey] = React.useState('');
    const [alias, setAlias] = React.useState('');
    const [stage, setStage] = React.useState('pubkey');
    const [isSigning, setIsSigning] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    useInput((input, key) => {
      if (key.escape || input === 'b') {
        if (typeof onCancel === 'function') onCancel();
        return;
      }
      if (stage === 'type') {
        if (input === 's') setIsSigning(true);
        if (input === 'w') setIsSigning(false);
        if (key.return) {
          void handleSubmit();
        }
      }
    });

    async function handleSubmit() {
      const trimmedPubkey = pubkey.trim();
      const trimmedAlias = alias.trim();
      if (!trimmedPubkey) {
        setStatus('Public key is required.');
        return;
      }
      if (!isBase58Pubkey(trimmedPubkey)) {
        setStatus('Public key does not look valid.');
        return;
      }
      if (!trimmedAlias) {
        setStatus('Alias is required.');
        return;
      }
      setBusy(true);
      try {
        const existing = await walletRegistry.getAllWallets();
        const color = pickNextColor(existing);
        const wallet = await walletRegistry.addWallet({
          alias: trimmedAlias,
          pubkey: trimmedPubkey,
          color,
          hasPrivateKey: isSigning,
          keySource: 'none',
          keyRef: null,
          usageType: 'funding',
          autoAttachWarchest: true,
        });
        if (bus) bus.emit({ text: `Added wallet ${wallet.alias}` });
        const currentDefault = await walletRegistry.getDefaultFundingWallet();
        if (!currentDefault) {
          await walletRegistry.setDefaultFundingWallet(wallet.alias);
        }
        onAdded(wallet);
      } catch (err) {
        setStatus(err?.message || String(err));
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
            h(Text, null, `Wallet type: ${isSigning ? 'signing' : 'watch-only'} (s/w)`),
            h(Text, { dimColor: true }, 'Next color: auto'),
            h(Text, { dimColor: true }, 'Press Enter to save, or b to cancel.')
          )
        : null,
      busy ? h(Spinner, { label: 'Saving wallet' }) : null,
      status ? h(Text, { color: 'yellow' }, status) : null
    );
  }

  function SwapPanel({ mint, opts = {}, bus, onExit }) {
    const [step, setStep] = React.useState(mint ? 'resolve' : 'mint');
    const [mintInfo, setMintInfo] = React.useState(mint ? { mint } : null);
    const [side, setSide] = React.useState(null);
    const [wallet, setWallet] = React.useState(null);
    const [amount, setAmount] = React.useState('');
    const [status, setStatus] = React.useState('');
    const [walletOptions, setWalletOptions] = React.useState([]);
    const [txSummary, setTxSummary] = React.useState(null);
    const [error, setError] = React.useState(null);

    async function resolveWalletHoldings(targetMint) {
      await ensureBootyBoxInit();
      const wallets = await walletRegistry.getAllWallets();
      const matches = [];
      for (const entry of wallets) {
        if (!entry || !entry.alias) continue;
        if (typeof BootyBox.loadOpenPositions !== 'function') continue;
        const open = await BootyBox.loadOpenPositions(entry.alias);
        const rows = Array.isArray(open?.rows) ? open.rows : [];
        const hit = rows.find((row) => {
          const rowMint = row.coin_mint || row.coinMint || row.mint;
          return rowMint === targetMint;
        });
        if (hit) {
          matches.push({ wallet: entry, position: hit });
        }
      }
      return matches;
    }

    async function loadFundedWalletOptions() {
      const wallets = await walletRegistry.listFundingWallets();
      const state = readJson(DEFAULT_HUD_STATE_PATH, null);
      const walletState = state && typeof state === 'object' ? state.state || {} : {};
      const enriched = wallets.map((entry) => {
        const solBalance = walletState && walletState[entry.alias]
          ? Number(walletState[entry.alias].solBalance)
          : null;
        return { wallet: entry, solBalance };
      });
      const funded = enriched.filter((entry) => Number.isFinite(entry.solBalance) && entry.solBalance > 0);
      return funded.length ? funded : enriched;
    }

    React.useEffect(() => {
      if (step !== 'resolve' || !mintInfo || !mintInfo.mint) return;
      let mounted = true;
      (async () => {
        setStatus('Resolving swap intent...');
        const mintValue = mintInfo.mint;
        const presetAmount = opts.buy || opts.sell || null;
        if (opts.buy || opts.sell) {
          setSide(opts.buy ? 'buy' : 'sell');
        } else {
          const holdings = await resolveWalletHoldings(mintValue);
          if (holdings.length) {
            setSide('sell');
            setWalletOptions(holdings.map((entry) => ({
              key: entry.wallet.alias,
              label: entry.wallet.alias,
              description: shortenAddress(entry.wallet.pubkey),
              value: entry.wallet,
            })));
            if (holdings.length === 1) {
              setWallet(holdings[0].wallet);
              if (presetAmount) {
                setAmount(String(presetAmount));
                setStep('run');
              } else {
                setStep('amount');
              }
              setStatus('');
              return;
            }
            setStep('wallet');
            setStatus('Select a wallet for sell');
            return;
          }
          setSide('buy');
        }

        if (opts.wallet) {
          const matches = await loadWalletMatches(opts.wallet);
          if (matches.length) {
            setWallet(matches[0]);
            if (presetAmount) {
              setAmount(String(presetAmount));
              setStep('run');
            } else {
              setStep('amount');
            }
            setStatus('');
            return;
          }
        }

        const funded = await loadFundedWalletOptions();
        const items = funded.map((entry) => ({
          key: entry.wallet.alias,
          label: formatWalletLabel(entry.wallet, entry.solBalance),
          description: shortenAddress(entry.wallet.pubkey),
          value: entry.wallet,
        }));
        items.push({ key: 'add', label: 'Add new wallet', description: 'Add to registry', value: null });
        if (!mounted) return;
        setWalletOptions(items);
        setStep('wallet');
        setStatus('Select a wallet for buy');
      })().catch((err) => {
        if (!mounted) return;
        setError(err?.message || String(err));
        setStep('error');
      });
      return () => {
        mounted = false;
      };
    }, [step, mintInfo, opts]);

    async function runSwap() {
      try {
        setStep('running');
        setStatus('Submitting swap...');
        const tradeCli = require('../cli/swap');
        const normalized = { ...opts };
        normalized.wallet = wallet.alias || wallet.pubkey;
        normalized.noInk = true;
        normalized.onProgress = (payload) => {
          if (bus) bus.emit({ text: formatSwapProgress(payload) });
        };
        if (side === 'buy') {
          normalized.buy = amount;
          delete normalized.sell;
        } else {
          const raw = String(amount || '').trim().toLowerCase();
          if (!raw || raw === 'auto') {
            normalized.sell = '100%';
            normalized._panic = true;
          } else {
            normalized.sell = amount;
          }
          delete normalized.buy;
        }
        const result = await tradeCli(mintInfo.mint, normalized);
        if (result && result.txSummary) {
          setTxSummary(result.txSummary);
        }
        setStatus('Swap completed.');
        setStep('summary');
      } catch (err) {
        setError(err?.message || String(err));
        setStep('error');
      }
    }

    React.useEffect(() => {
      if (step !== 'run') return;
      runSwap();
    }, [step]);

    if (step === 'mint') {
      return h(MintLookupPanel, {
        label: 'Mint or symbol for swap:',
        initialQuery: mint || '',
        onSelect: (selected) => {
          setMintInfo(selected);
          setStep('resolve');
        },
        onCancel: onExit,
        bus,
      });
    }

    if (step === 'wallet') {
      return h(SelectList, {
        items: walletOptions,
        title: status || 'Select wallet',
        hint: 'Use arrows and Enter. Press b to go back.',
        onSelect: (item) => {
          if (item.key === 'add') {
            setStep('add-wallet');
            return;
          }
          setWallet(item.value || item);
          if (opts.buy || opts.sell) {
            setAmount(String(opts.buy || opts.sell));
            setStep('run');
          } else {
            setStep('amount');
          }
          setStatus('');
        },
        onCancel: onExit,
      });
    }

    if (step === 'add-wallet') {
      return h(AddWalletPanel, {
        onAdded: (walletRecord) => {
          setWallet(walletRecord);
          if (opts.buy || opts.sell) {
            setAmount(String(opts.buy || opts.sell));
            setStep('run');
          } else {
            setStep('amount');
          }
        },
        onCancel: () => setStep('wallet'),
        bus,
      });
    }

    if (step === 'amount') {
      const prompt = side === 'sell'
        ? 'Enter sell amount (token amount, percent, or auto):'
        : 'Enter buy amount (SOL or percent):';
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, prompt),
        h(TextInput, {
          value: amount,
          onChange: setAmount,
          onSubmit: runSwap,
          placeholder: side === 'sell' ? 'auto or 50%' : '0.1 or 25%',
        }),
        h(Text, { dimColor: true }, `Wallet: ${wallet ? wallet.alias : 'unknown'} | Side: ${side}`)
      );
    }

    if (step === 'run') {
      return h(Spinner, { label: 'Starting swap' });
    }

    if (step === 'running') {
      return h(
        Box,
        { flexDirection: 'column' },
        h(Spinner, { label: status || 'Running swap' }),
        h(Text, { dimColor: true }, `Mint: ${mintInfo ? shortenAddress(mintInfo.mint) : 'n/a'}`),
        h(ProgressBar, { value: 0.5 })
      );
    }

    if (step === 'summary') {
      return h(
        Box,
        { flexDirection: 'column' },
        txSummary ? h(TxSummaryCard, { summary: txSummary }) : h(Text, null, status || 'Swap complete.'),
        h(Text, { dimColor: true }, 'Press q to exit.')
      );
    }

    if (step === 'error') {
      return h(Text, { color: 'red' }, error || 'Swap failed.');
    }

    return h(Text, null, status || 'Working...');
  }

  function TxPanel({ signature, opts = {}, bus, onExit }) {
    const needsWallet = !!opts.swap && !opts.wallet;
    const needsMint = !!opts.swap && !opts.mint;
    const initialStep = signature
      ? (needsWallet ? 'wallet' : needsMint ? 'mint' : 'run')
      : 'input';
    const [step, setStep] = React.useState(initialStep);
    const [sigValue, setSigValue] = React.useState(signature || '');
    const [wallet, setWallet] = React.useState(opts.wallet ? { alias: opts.wallet, pubkey: opts.wallet } : null);
    const [mintInfo, setMintInfo] = React.useState(opts.mint ? { mint: opts.mint } : null);
    const [summary, setSummary] = React.useState(null);
    const [status, setStatus] = React.useState('');
    const [error, setError] = React.useState(null);

    async function runTx() {
      try {
        setStatus('Inspecting transaction...');
        setStep('running');
        const txProcessor = require('../cli/tx');
        const cmd = { ...opts, tui: true };
        if (wallet) cmd.wallet = wallet.alias || wallet.pubkey;
        if (mintInfo) cmd.mint = mintInfo.mint;
        const restore = captureConsole((line) => bus && bus.emit({ text: line }));
        let result;
        try {
          result = await txProcessor({ signature: sigValue, cmd });
        } finally {
          restore();
        }
        const first = result && Array.isArray(result.results) && result.results.length
          ? result.results[0]
          : null;
        if (first && first.summary) {
          setSummary(first.summary);
        }
        setStep('summary');
        setStatus('Inspection complete.');
      } catch (err) {
        setError(err?.message || String(err));
        setStep('error');
      }
    }

    React.useEffect(() => {
      if (step !== 'run') return;
      runTx();
    }, [step]);

    if (step === 'input') {
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, 'Enter transaction signature:'),
        h(TextInput, {
          value: sigValue,
          onChange: setSigValue,
          onSubmit: () => {
            if (!sigValue.trim()) {
              setStatus('Signature is required.');
              return;
            }
            if (opts.swap && !wallet) {
              setStep('wallet');
              return;
            }
            if (opts.swap && !mintInfo) {
              setStep('mint');
              return;
            }
            runTx();
          },
          placeholder: 'signature',
        }),
        status ? h(Text, { dimColor: true }, status) : null
      );
    }

    if (step === 'wallet') {
      return h(WalletLookupPanel, {
        label: 'Wallet for swap context:',
        initialQuery: opts.wallet || '',
        onSelect: (selected) => {
          setWallet(selected);
          setStep(opts.swap && !mintInfo ? 'mint' : 'run');
        },
        onCancel: onExit,
      });
    }

    if (step === 'mint') {
      return h(MintLookupPanel, {
        label: 'Mint for swap context:',
        initialQuery: opts.mint || '',
        onSelect: (selected) => {
          setMintInfo(selected);
          setStep('run');
        },
        onCancel: onExit,
        bus,
      });
    }

    if (step === 'run') {
      return h(Spinner, { label: 'Starting tx inspection' });
    }

    if (step === 'running') {
      return h(Spinner, { label: status || 'Inspecting' });
    }

    if (step === 'summary') {
      return h(
        Box,
        { flexDirection: 'column' },
        summary ? h(TxSummaryCard, { summary }) : h(Text, null, 'No summary available.'),
        h(Text, { dimColor: true }, 'Press q to exit.')
      );
    }

    if (step === 'error') {
      return h(Text, { color: 'red' }, error || 'Tx inspection failed.');
    }

    return h(Text, null, status || 'Idle');
  }

  function AddcoinPanel({ mint, opts = {}, bus, onExit }) {
    const [step, setStep] = React.useState(mint ? 'run' : 'mint');
    const [mintInfo, setMintInfo] = React.useState(mint ? { mint } : null);
    const [status, setStatus] = React.useState('');
    const [error, setError] = React.useState(null);

    async function runAddcoin() {
      try {
        setStatus('Ensuring token info...');
        setStep('running');
        const addcoin = require('../cli/addcoin');
        const restore = captureConsole((line) => bus && bus.emit({ text: line }));
        try {
          await addcoin.run({
            mint: mintInfo.mint,
            forceRefresh: !!opts.force,
          });
        } finally {
          restore();
        }
        setStatus('Addcoin complete.');
        setStep('done');
      } catch (err) {
        setError(err?.message || String(err));
        setStep('error');
      }
    }

    React.useEffect(() => {
      if (step !== 'run') return;
      runAddcoin();
    }, [step]);

    if (step === 'mint') {
      return h(MintLookupPanel, {
        label: 'Mint or symbol to add:',
        initialQuery: mint || '',
        onSelect: (selected) => {
          setMintInfo(selected);
          setStep('run');
        },
        onCancel: onExit,
        bus,
      });
    }

    if (step === 'run') {
      return h(Spinner, { label: 'Starting addcoin' });
    }

    if (step === 'running') {
      return h(Spinner, { label: status || 'Running' });
    }

    if (step === 'done') {
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, status || 'Addcoin complete.'),
        h(Text, { dimColor: true }, 'Press q to exit.')
      );
    }

    if (step === 'error') {
      return h(Text, { color: 'red' }, error || 'Addcoin failed.');
    }

    return h(Text, null, status || 'Idle');
  }

  function WalletPanel({ opts = {}, onExit }) {
    const [WalletManagerApp, setWalletManagerApp] = React.useState(null);
    const [status, setStatus] = React.useState('');
    const routeMap = {
      add: 'add',
      list: 'list',
      remove: 'remove',
      'set-color': 'color',
      options: 'options',
      configure: 'options',
    };
    const initialRoute = opts.solo ? 'solo' : (routeMap[opts.subcommand] || 'menu');

    React.useEffect(() => {
      let mounted = true;
      (async () => {
        try {
          const mod = require('../wallets/inkWalletManager');
          const loaded = await mod.loadWalletManagerApp();
          if (mounted) setWalletManagerApp(() => loaded.WalletManagerApp);
        } catch (err) {
          if (mounted) setStatus(err?.message || String(err));
        }
      })();
      return () => {
        mounted = false;
      };
    }, []);

    if (status) return h(Text, { color: 'red' }, status);
    if (!WalletManagerApp) return h(Spinner, { label: 'Loading wallet manager' });

    return h(WalletManagerApp, {
      initialRoute,
      initialWalletAlias: opts.walletAlias || null,
      initialColor: opts.color || null,
      onComplete: onExit,
    });
  }

  function GenericCommandPanel({ label, run, bus, onExit }) {
    const [step, setStep] = React.useState('running');
    const [status, setStatus] = React.useState('');
    const [error, setError] = React.useState(null);

    React.useEffect(() => {
      let mounted = true;
      (async () => {
        let restore = null;
        try {
          if (typeof run !== 'function') {
            throw new Error('Command handler is unavailable.');
          }
          restore = captureConsole((line) => bus && bus.emit({ text: line }));
          setStatus('Running...');
          await run();
          if (mounted) {
            setStatus('Complete.');
            setStep('done');
          }
        } catch (err) {
          if (mounted) {
            setError(err?.message || String(err));
            setStep('error');
          }
        } finally {
          if (restore) restore();
        }
      })();
      return () => {
        mounted = false;
      };
    }, [run, bus]);

    if (step === 'running') {
      return h(Spinner, { label: label || status });
    }
    if (step === 'done') {
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, status || 'Done.'),
        h(Text, { dimColor: true }, 'Press q to exit.')
      );
    }
    if (step === 'error') {
      return h(Text, { color: 'red' }, error || 'Command failed.');
    }
    return h(Text, null, status || 'Idle');
  }

  function CommandTuiApp({ command, args, options, run }) {
    const { exit } = useApp();
    const eventBus = React.useMemo(() => createEventBus(), []);
    const events = useEventLog(eventBus);

    React.useEffect(() => {
      clearScreen();
      const restoreLogger = captureLogger(eventBus);
      return () => {
        restoreLogger();
        clearScreen();
      };
    }, []);

    React.useEffect(() => {
      const follower = createHubEventFollower({ readInitial: true });
      follower.onEvent((event) => {
        const summary = event && event.summary ? event.summary : summarizeHubEvent(event);
        eventBus.emit({ text: summary });
      });
      return () => follower.close();
    }, [eventBus]);

    useInput((input, key) => {
      if (key.ctrl && input === 'c') exit();
      if (input === 'q') exit();
    });

    const headerTitle = `scoundrel ${command}`;
    let content = null;
    const opts = options || {};

    if (command === 'swap') {
      content = h(SwapPanel, {
        mint: args && args.mint ? args.mint : null,
        opts,
        bus: eventBus,
        onExit: exit,
      });
    } else if (command === 'tx') {
      content = h(TxPanel, {
        signature: args && args.signature ? args.signature : null,
        opts,
        bus: eventBus,
        onExit: exit,
      });
    } else if (command === 'addcoin') {
      content = h(AddcoinPanel, {
        mint: args && args.mint ? args.mint : null,
        opts,
        bus: eventBus,
        onExit: exit,
      });
    } else if (command === 'wallet') {
      content = h(WalletPanel, {
        opts,
        onExit: exit,
      });
    } else {
      const label = command || 'command';
      content = h(GenericCommandPanel, {
        label: `Running ${label}`,
        run,
        bus: eventBus,
        onExit: exit,
      });
    }

    return h(
      Box,
      { flexDirection: 'column', height: '100%' },
      h(Header, { title: headerTitle }),
      h(Panel, { title: 'Command', grow: true }, content),
      h(EventLog, { events, title: 'Events', maxItems: 12 }),
      h(Footer, { hint: 'Press q to quit.' })
    );
  }

  return { CommandTuiApp };
}

/**
 * Async loader for the command TUI app.
 *
 * @returns {Promise<{CommandTuiApp: Function}>}
 */
async function loadCommandTuiApp() {
  const ink = await import('ink');
  const inkTextInputMod = await import('ink-text-input');
  const TextInput = inkTextInputMod?.default || inkTextInputMod;
  return createCommandTuiComponents(ink, TextInput);
}

module.exports = {
  loadCommandTuiApp,
};
