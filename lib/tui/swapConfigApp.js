'use strict';

const React = require('react');
const { getConfigPath, loadConfig, saveConfig } = require('../swap/swapConfig');

const PRIORITY_FEE_LEVELS = ['min', 'low', 'medium', 'high', 'veryHigh', 'unsafeMax'];
const TX_VERSIONS = ['v0', 'V0', 'legacy'];
const SWAP_PROVIDERS = ['swapV3', 'raptor'];

const READ_ONLY_SETTINGS = [
  {
    key: 'rpcUrl',
    label: 'RPC URL',
    description: 'SolanaTracker RPC endpoint (managed outside the config editor).',
    redact: false,
  },
];

const EDITABLE_SETTINGS = [
  {
    key: 'slippage',
    label: 'Slippage (%)',
    description: 'Maximum allowed slippage percentage.',
    type: 'number',
    min: 0,
  },
  {
    key: 'swapApiKey',
    label: 'Swap API key',
    description: 'SolanaTracker swap API key (used to build swap transactions).',
    type: 'string',
    redact: true,
  },
  {
    key: 'swapApiProvider',
    label: 'Swap API provider',
    description: `Swap engine provider (${SWAP_PROVIDERS.join(', ')}).`,
    type: 'enum',
    options: SWAP_PROVIDERS,
  },
  {
    key: 'swapApiBaseUrl',
    label: 'Swap API base URL',
    description: 'Base URL for the SolanaTracker swap API.',
    type: 'string',
  },
  {
    key: 'preflight',
    label: 'Preflight simulation',
    description: 'Simulate swap transactions before sending.',
    type: 'boolean',
  },
  {
    key: 'maxPriceImpact',
    label: 'Max price impact (%)',
    description: 'Abort swaps above this price impact percentage (leave blank to disable).',
    type: 'optional-number',
    min: 0,
  },
  {
    key: 'inkMode',
    label: 'Ink mode',
    description: 'Suppress worker console output for Ink UI.',
    type: 'boolean',
  },
  {
    key: 'explorerBaseUrl',
    label: 'Explorer base URL',
    description: 'Base URL used when building transaction explorer links.',
    type: 'string',
  },
  {
    key: 'priorityFee',
    label: 'Priority fee',
    description: 'Priority fee in SOL, or "auto" for dynamic fees.',
    type: 'auto-number',
    min: 0,
  },
  {
    key: 'priorityFeeLevel',
    label: 'Priority fee level',
    description: `Hint for auto priority fee (${PRIORITY_FEE_LEVELS.join(', ')}).`,
    type: 'enum',
    options: PRIORITY_FEE_LEVELS,
  },
  {
    key: 'txVersion',
    label: 'Transaction version',
    description: `Swap transaction format (${TX_VERSIONS.join(', ')}).`,
    type: 'enum',
    options: TX_VERSIONS,
  },
  {
    key: 'showQuoteDetails',
    label: 'Show quote details',
    description: 'Log swap quote payloads for debugging.',
    type: 'boolean',
  },
  {
    key: 'DEBUG_MODE',
    label: 'Debug logging',
    description: 'Enable verbose swap logging.',
    type: 'boolean',
  },
  {
    key: 'useJito',
    label: 'Use Jito bundles',
    description: 'Send swaps via Jito bundles (requires tip).',
    type: 'boolean',
  },
  {
    key: 'jitoTip',
    label: 'Jito tip (SOL)',
    description: 'Tip amount in SOL for Jito bundles.',
    type: 'number',
    min: 0,
  },
];

function formatValue(def, value) {
  if (value === undefined || value === null) return 'n/a';
  if (def && def.redact && typeof value === 'string') {
    const tail = value.slice(-4);
    return value ? `********${tail}` : 'n/a';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function normalizeEnum(value, options) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  for (const option of options) {
    if (option === trimmed) return option;
  }
  const lower = trimmed.toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]/g, '');
  for (const option of options) {
    const optLower = option.toLowerCase();
    if (optLower === lower) return option;
    if (optLower.replace(/[^a-z0-9]/g, '') === cleaned) return option;
  }
  return null;
}

function parseBoolean(raw) {
  const trimmed = String(raw || '').trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1', 'on'].includes(trimmed)) return true;
  if (['false', 'f', 'no', 'n', '0', 'off'].includes(trimmed)) return false;
  return null;
}

function validateSettingValue(def, raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return { ok: false, error: 'Value cannot be empty.' };
  }

  if (def.type === 'number') {
    const num = Number(input);
    if (!Number.isFinite(num)) return { ok: false, error: 'Value must be a number.' };
    if (def.min !== undefined && num < def.min) {
      return { ok: false, error: `Value must be >= ${def.min}.` };
    }
    return { ok: true, value: num };
  }

  if (def.type === 'auto-number') {
    if (input.toLowerCase() === 'auto') {
      return { ok: true, value: 'auto' };
    }
    const num = Number(input);
    if (!Number.isFinite(num)) return { ok: false, error: 'Value must be a number or "auto".' };
    if (def.min !== undefined && num < def.min) {
      return { ok: false, error: `Value must be >= ${def.min}.` };
    }
    return { ok: true, value: num };
  }

  if (def.type === 'optional-number') {
    if (!input) return { ok: true, value: null };
    const num = Number(input);
    if (!Number.isFinite(num)) return { ok: false, error: 'Value must be a number.' };
    if (def.min !== undefined && num < def.min) {
      return { ok: false, error: `Value must be >= ${def.min}.` };
    }
    return { ok: true, value: num };
  }

  if (def.type === 'enum') {
    const normalized = normalizeEnum(input, def.options || []);
    if (!normalized) {
      return { ok: false, error: `Value must be one of: ${def.options.join(', ')}.` };
    }
    return { ok: true, value: normalized };
  }

  if (def.type === 'boolean') {
    const parsed = parseBoolean(input);
    if (parsed === null) return { ok: false, error: 'Value must be true or false.' };
    return { ok: true, value: parsed };
  }

  if (def.type === 'string') {
    return { ok: true, value: input };
  }

  return { ok: false, error: 'Unsupported setting type.' };
}

function toInputValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Factory that builds Ink components using the provided Ink bindings.
 *
 * @param {object} ink - The ESM namespace returned by `import('ink')`
 * @param {object} TextInput - The Ink TextInput component loaded via dynamic import
 * @returns {{ SwapConfigApp: Function }}
 */
function createSwapConfigComponents(ink, TextInput) {
  const { Box, Text, useApp, useInput } = ink;
  const h = React.createElement;

  function Heading({ children }) {
    return h(Box, { marginBottom: 1 }, h(Text, { bold: true }, children));
  }

  function Menu({ options, cursor, onSelect, formatLabel }) {
    useInput((input, key) => {
      if (key.upArrow) {
        onSelect(Math.max(cursor - 1, 0), false);
      } else if (key.downArrow) {
        onSelect(Math.min(cursor + 1, options.length - 1), false);
      } else if (key.return) {
        onSelect(cursor, true);
      } else if (input === 'b' || key.escape) {
        onSelect(-1, true);
      }
    });

    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      options.map((opt, idx) => {
        const active = idx === cursor;
        const label = formatLabel ? formatLabel(opt, idx) : opt.label;
        return h(
          Text,
          { key: opt.key, color: active ? 'cyan' : undefined },
          `${active ? '› ' : '  '}${label}`
        );
      })
    );
  }

  function StatusLine({ message, color = 'yellow' }) {
    if (!message) return null;
    return h(Box, { marginTop: 1 }, h(Text, { color }, message));
  }

  function SettingLine({ label, value, description, dim }) {
    return h(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      h(Text, { dimColor: Boolean(dim) }, `${label}: ${value}`),
      description ? h(Text, { dimColor: true }, description) : null
    );
  }

  function ViewScreen({ config, configPath, onEdit, onReload, onExit, error, status }) {
    useInput((input, key) => {
      if (input === 'e') {
        onEdit();
      } else if (input === 'r') {
        onReload();
      } else if (input === 'q' || key.escape) {
        onExit();
      }
    });

    const lines = [
      ...READ_ONLY_SETTINGS.map((def) =>
        h(SettingLine, {
          key: def.key,
          label: def.label,
          value: formatValue(def, config[def.key]),
          description: def.description,
          dim: true,
        })
      ),
      ...EDITABLE_SETTINGS.map((def) =>
        h(SettingLine, {
          key: def.key,
          label: def.label,
          value: formatValue(def, config[def.key]),
          description: def.description,
        })
      ),
    ];

    const providerHintSource = config.swapApiProvider || process.env.SWAP_API_PROVIDER || '';
    const raptorNeedsBaseUrl =
      String(providerHintSource || '').toLowerCase() === 'raptor' &&
      /swap-v2/i.test(String(config.swapApiBaseUrl || ''));

    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Swap config'),
      h(Text, { dimColor: true }, `Config file: ${configPath}`),
      h(Box, { flexDirection: 'column', marginTop: 1 }, lines),
      h(StatusLine, {
        message: raptorNeedsBaseUrl
          ? 'Hint: swapApiProvider=raptor expects a Raptor base URL (ex: https://raptor-beta.solanatracker.io).'
          : '',
        color: 'yellow',
      }),
      h(StatusLine, { message: error, color: 'red' }),
      h(StatusLine, { message: status }),
      h(Text, { dimColor: true }, 'Press e to edit, r to reload, q to exit.')
    );
  }

  function EditListScreen({ config, cursor, onSelect, error }) {
    const providerHintSource = config.swapApiProvider || process.env.SWAP_API_PROVIDER || '';
    const raptorNeedsBaseUrl =
      String(providerHintSource || '').toLowerCase() === 'raptor' &&
      /swap-v2/i.test(String(config.swapApiBaseUrl || ''));

    return h(
      React.Fragment,
      null,
      h(Heading, null, 'Edit swap settings'),
      h(Text, { dimColor: true }, 'Select a setting (Up/Down, Enter). Press b to go back.'),
      h(Menu, {
        options: EDITABLE_SETTINGS,
        cursor,
        onSelect,
        formatLabel: (def) => `${def.label}: ${formatValue(def, config[def.key])}`,
      }),
      h(StatusLine, {
        message: raptorNeedsBaseUrl
          ? 'Hint: swapApiProvider=raptor expects a Raptor base URL (ex: https://raptor-beta.solanatracker.io).'
          : '',
        color: 'yellow',
      }),
      h(StatusLine, { message: error, color: 'red' })
    );
  }

  function EditValueScreen({ def, inputValue, onChange, onSubmit, onCancel, error, busy, showRaptorHint }) {
    useInput((input, key) => {
      if (key.escape || input === 'b') {
        onCancel();
      }
    });

    return h(
      Box,
      { flexDirection: 'column' },
      h(Heading, null, `Edit ${def.label}`),
      h(Text, { dimColor: true }, def.description),
      def.type === 'enum'
        ? h(Text, { dimColor: true }, `Options: ${def.options.join(', ')}`)
        : null,
      def.type === 'auto-number'
        ? h(Text, { dimColor: true }, 'Enter a number or "auto".')
        : null,
      def.type === 'optional-number'
        ? h(Text, { dimColor: true }, 'Enter a number or leave blank.')
        : null,
      def.type === 'boolean'
        ? h(Text, { dimColor: true }, 'Enter true or false.')
        : null,
      h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, 'New value: ')),
      h(TextInput, {
        value: inputValue,
        onChange,
        onSubmit,
      }),
      h(StatusLine, {
        message: showRaptorHint
          ? 'Hint: swapApiProvider=raptor expects a Raptor base URL (ex: https://raptor-beta.solanatracker.io).'
          : '',
        color: 'yellow',
      }),
      h(StatusLine, { message: busy ? 'Saving...' : error, color: error ? 'red' : 'yellow' }),
      h(Text, { dimColor: true }, 'Press b to cancel.')
    );
  }

  function SwapConfigApp({ onComplete }) {
    const { exit } = useApp();
    const [route, setRoute] = React.useState('view');
    const [config, setConfig] = React.useState(null);
    const [cursor, setCursor] = React.useState(0);
    const [status, setStatus] = React.useState('');
    const [error, setError] = React.useState('');
    const [editingKey, setEditingKey] = React.useState(null);
    const [inputValue, setInputValue] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const configPath = getConfigPath();

    React.useEffect(() => {
      let mounted = true;
      loadConfig()
        .then((cfg) => {
          if (!mounted) return;
          setConfig(cfg || {});
        })
        .catch((err) => {
          if (!mounted) return;
          setError(err?.message || String(err));
        });
      return () => {
        mounted = false;
      };
    }, []);

    React.useEffect(() => {
      if (route === 'exit') {
        onComplete && onComplete();
        exit();
      }
    }, [route, exit, onComplete]);

    function handleSelectSetting(idx, confirmed) {
      if (!confirmed) {
        if (idx >= 0) setCursor(idx);
        return;
      }
      if (idx === -1) {
        setRoute('view');
        return;
      }
      const def = EDITABLE_SETTINGS[idx];
      if (!def) return;
      setEditingKey(def.key);
      setInputValue(toInputValue(config && config[def.key]));
      setRoute('edit-value');
    }

    async function saveValue(def, nextValue) {
      setBusy(true);
      setError('');
      setStatus('');
      try {
        const nextConfig = { ...(config || {}) };
        nextConfig[def.key] = nextValue;
        await saveConfig(nextConfig);
        setConfig(nextConfig);
        setStatus(`Updated ${def.label}.`);
        setRoute('view');
      } catch (err) {
        setError(err?.message || String(err));
      } finally {
        setBusy(false);
      }
    }

    if (!config) {
      return h(
        Box,
        { flexDirection: 'column' },
        h(Heading, null, 'Swap config'),
        h(Text, { dimColor: true }, 'Loading swap configuration...'),
        h(StatusLine, { message: error, color: 'red' })
      );
    }

    if (route === 'edit-list') {
      return h(EditListScreen, {
        config,
        cursor,
        onSelect: handleSelectSetting,
        error,
      });
    }

    if (route === 'edit-value') {
      const def = EDITABLE_SETTINGS.find((item) => item.key === editingKey);
      if (!def) {
        setRoute('view');
        return null;
      }
      const providerHintSource = (config && (config.swapApiProvider || process.env.SWAP_API_PROVIDER)) || '';
      const showRaptorHint =
        String(providerHintSource || '').toLowerCase() === 'raptor' &&
        /swap-v2/i.test(String((config && config.swapApiBaseUrl) || ''));
      return h(EditValueScreen, {
        def,
        inputValue,
        onChange: setInputValue,
        onSubmit: async (value) => {
          const result = validateSettingValue(def, value);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          await saveValue(def, result.value);
        },
        onCancel: () => setRoute('view'),
        error,
        busy,
        showRaptorHint,
      });
    }

    return h(ViewScreen, {
      config,
      configPath,
      onEdit: () => setRoute('edit-list'),
      onReload: () => {
        setStatus('Reloading config...');
        loadConfig()
          .then((cfg) => {
            setConfig(cfg || {});
            setStatus('Config reloaded.');
          })
          .catch((err) => setError(err?.message || String(err)));
      },
      onExit: () => setRoute('exit'),
      error,
      status,
    });
  }

  return { SwapConfigApp };
}

/**
 * Async loader for the Ink swap config app.
 *
 * @returns {Promise<{SwapConfigApp: Function}>}
 */
async function loadSwapConfigApp() {
  const ink = await import('ink');
  const inkTextInputMod = await import('ink-text-input');
  const TextInput = inkTextInputMod?.default || inkTextInputMod;

  return createSwapConfigComponents(ink, TextInput);
}

module.exports = {
  loadSwapConfigApp,
};
