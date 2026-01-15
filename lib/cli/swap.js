const path = require('path');
const logger = require('../logger');
const EventEmitter = require('events');
const { buildWorkerEnv } = require('../warchest/workers/harness');
const { getHubCoordinator } = require('../warchest/hub');
const { createWalletResolver } = require('../wallets/resolver');
const { selectWalletInteractively } = require('../wallets/walletSelection');
const { isWarchestServiceRunning, WARCHEST_PID_FILE } = require('../warchest/daemonStatus');
const { classifySolanaError } = require('../solana/errors');

const walletResolver = createWalletResolver();

/**
 * Quick-and-dirty SPL mint validator (Base58, 32-44 chars).
 * This intentionally mirrors the pattern used in summonTheWarlord.
 * @param {string} mint
 * @returns {boolean}
 */
function isValidMint(mint) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint || '').trim());
}

/**
 * Normalize a trade amount argument.
 *
 * - For numbers: returns a positive Number.
 * - For percentages: keeps the original string (e.g. "50%").
 * - For "auto": keeps the string "auto".
 *
 * @param {('buy'|'sell')} side
 * @param {string|number} raw
 * @returns {number|string}
 */
function normalizeAmount(side, raw) {
  if (raw === undefined || raw === null) {
    throw new Error(`Missing amount for ${side} side`);
  }

  let s = raw.toString().trim().toLowerCase().replace(/\s+/g, '');

  if (!s) {
    throw new Error('Amount cannot be empty');
  }

  if (s === 'auto') {
    if (side === 'buy') {
      throw new Error("'auto' is only valid for sells (swap entire balance)");
    }
    return 'auto';
  }

  if (s.endsWith('%')) {
    const num = parseFloat(s.slice(0, -1));
    if (!Number.isFinite(num) || num <= 0 || num > 100) {
      throw new Error('Percentage amount must be between 0 and 100');
    }
    return `${num}%`; // normalized percentage
  }

  const num = parseFloat(s);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Amount must be a positive number');
  }

  return num; // plain numeric amount (SOL for buys, tokens for sells)
}

function buildExplorerUrl(txid, explorerBaseUrl) {
  const base = explorerBaseUrl || 'https://solscan.io/tx';
  return txid ? `${base}/${txid}` : null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatErrMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  try {
    if (err.message) return String(err.message);
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function shorten(v, left = 10, right = 6) {
  if (!v || typeof v !== 'string') return '';
  if (v.length <= left + right + 3) return v;
  return `${v.slice(0, left)}...${v.slice(-right)}`;
}


function fmtNum(n, maxDp = 9) {
  if (n == null) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return x.toFixed(maxDp).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1');
}

function toggleLoggerConsoleSilent(log, silent) {
  if (!log || !Array.isArray(log.transports)) {
    return () => {};
  }

  const consoleTransports = log.transports.filter((transport) => {
    if (!transport) return false;
    if (transport.name === 'console') return true;
    if (transport.constructor && transport.constructor.name === 'Console') return true;
    return false;
  });
  const prev = consoleTransports.map((transport) => transport.silent);
  consoleTransports.forEach((transport) => {
    transport.silent = silent;
  });

  return function restore() {
    consoleTransports.forEach((transport, idx) => {
      transport.silent = prev[idx];
    });
  };
}

/**
 * Ink (TUI) requires exclusive control of stdout. Any console/logger writes
 * while Ink is mounted will corrupt the UI and cause it to "append" lines.
 *
 * This helper temporarily silences console output and the logger's console
 * transport, then returns a restore function.
 *
 * @param {object} log
 * @returns {() => void}
 */
function muteStdoutLogging(log) {
  const noop = () => {};

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const restoreLoggerConsole = toggleLoggerConsoleSilent(log, true);

  // Silence console output (stdout/stderr) while Ink owns the terminal.
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;

  return function restore() {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    restoreLoggerConsole();
  };
}

function buildTxSummaryFromSwapResult({ result, monitorResult, side, explorerBaseUrl }) {
  const txid = result.txid || result.signature || null;
  const confirmed = monitorResult && monitorResult.status === 'confirmed';
  const failed = monitorResult && monitorResult.status === 'failed';
  const timedOut = monitorResult && monitorResult.status === 'timeout';

  const status = confirmed ? 'ok' : failed ? 'failed' : timedOut ? 'unknown' : 'unknown';

  const err = failed ? (monitorResult.err || null) : null;
  const errorSummary = failed
    ? (monitorResult.errorSummary || (err ? classifySolanaError(err) : null))
    : null;
  const errMessage = failed
    ? (errorSummary && errorSummary.userMessage ? errorSummary.userMessage : formatErrMessage(err))
    : '';

  return {
    kind: 'swap',
    status,
    label: confirmed
      ? `${result.side || side} swap confirmed`
      : failed
        ? `${result.side || side} swap failed`
        : timedOut
          ? `${result.side || side} swap timed out`
          : `${result.side || side} swap submitted`,
    side: result.side || side || null,
    mint: result.mint || null,
    txid,
    explorerUrl: buildExplorerUrl(txid, explorerBaseUrl),
    durationMs: result.timing && typeof result.timing.durationMs === 'number' ? result.timing.durationMs : null,

    tokens: Object.prototype.hasOwnProperty.call(result, 'tokensReceivedDecimal') ? result.tokensReceivedDecimal : null,
    sol: Object.prototype.hasOwnProperty.call(result, 'solReceivedDecimal') ? result.solReceivedDecimal : null,
    totalFeesSol: Object.prototype.hasOwnProperty.call(result, 'totalFees') ? result.totalFees : null,
    priceImpactPct: Object.prototype.hasOwnProperty.call(result, 'priceImpact') ? result.priceImpact : null,
    quote: result.quote && typeof result.quote === 'object' ? result.quote : null,

    err,
    errMessage,
    errorSummary: errorSummary || null,
  };
}

function buildSwapErrorSummary({ err, side, mint, label }) {
  const summary = err ? classifySolanaError(err) : null;
  const errMessage =
    summary && summary.userMessage
      ? summary.userMessage
      : formatErrMessage(err);
  const sideLabel = side ? String(side).toUpperCase() : 'SWAP';
  return {
    kind: 'swap',
    status: 'failed',
    label: label || `${sideLabel} swap failed`,
    side,
    mint,
    err: err || null,
    errMessage,
    errorSummary: summary || null,
  };
}

function logSwapFailure(log, err, context) {
  if (!log || typeof log.error !== 'function') return;
  const summary = err ? classifySolanaError(err) : null;
  log.error('[scoundrel:swap] swap failed', {
    message: err?.message || String(err),
    name: err?.name || null,
    stack: err?.stack || null,
    errorSummary: summary || null,
    context: context || null,
  });
}

function installSwapInkGuards({ progressUi, restoreLogging, side, mint, log }) {
  if (!progressUi) return () => {};
  let handled = false;
  const swapLogger = log && typeof log.error === 'function' ? log : logger;

  const handleFatal = async (err, source) => {
    if (handled) return;
    handled = true;
    const summary = buildSwapErrorSummary({
      err,
      side,
      mint,
      label: `${side ? String(side).toUpperCase() : 'SWAP'} swap crashed`,
    });
    if (swapLogger && typeof swapLogger.error === 'function') {
      swapLogger.error('[scoundrel:swap] unhandled swap error', {
        source,
        message: err?.message || String(err),
        name: err?.name || null,
        stack: err?.stack || null,
        errorSummary: summary.errorSummary || null,
      });
    }
    try {
      progressUi.setSummary(summary);
      await progressUi.waitUntilExit();
    } catch (_) {
      // ignore
    } finally {
      try {
        progressUi.unmount();
      } catch (_) {
        // ignore
      }
      if (restoreLogging) {
        try {
          restoreLogging();
        } catch (_) {
          // ignore
        }
      }
    }
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50);
  };

  const onUncaught = (err) => {
    handleFatal(err, 'uncaughtException');
  };
  const onRejection = (reason) => {
    const err = reason instanceof Error ? reason : new Error(formatErrMessage(reason));
    handleFatal(err, 'unhandledRejection');
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return function restore() {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  };
}

async function renderTxSummaryCardInk(txSummary) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  const ink = await import('ink');
  const React = require('react');
  const h = React.createElement;

  const { render, Box, Text } = ink;

  function Line({ label, value, dim }) {
    if (value === null || value === undefined || value === '') return null;
    return h(
      Box,
      { flexDirection: 'row' },
      h(Text, { dimColor: true }, `${label}: `),
      h(Text, { dimColor: Boolean(dim) }, String(value))
    );
  }

  function Border({ children }) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, '┌──────────────────────────────────────────────┐'),
      h(Box, { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }, children),
      h(Text, null, '└──────────────────────────────────────────────┘')
    );
  }

  function pickQuoteField(q, keys) {
    if (!q || typeof q !== 'object') return null;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(q, k) && q[k] !== undefined && q[k] !== null) {
        return q[k];
      }
    }
    return null;
  }

  function fmtSlippage(v) {
    const n = toNum(v);
    if (n == null) return null;

    // Common cases:
    // - slippageBps (e.g. 150 = 1.5%)
    // - slippagePct (e.g. 1.5)
    // - slippage (ambiguous) -> treat <= 1 as fraction, else percent
    if (n > 0 && n <= 1) {
      return `${fmtNum(n * 100, 4)}%`;
    }

    // Heuristic: if it looks like basis points (integer-ish and > 10), convert
    if (Number.isInteger(n) && n >= 10 && n <= 10_000) {
      return `${fmtNum(n / 100, 4)}%`;
    }

    return `${fmtNum(n, 4)}%`;
  }

  function App() {
    const s = txSummary || {};
    const ok = s.status === 'ok';
    const failed = s.status === 'failed';
    const titleColor = ok ? 'green' : failed ? 'red' : 'yellow';
    const icon = ok ? '✅' : failed ? '❌' : 'ℹ️';

    return h(
      Border,
      null,
      h(Text, { bold: true, color: titleColor }, `${icon} ${s.label || 'transaction'}`),
      h(Line, { label: 'txid', value: shorten(s.txid) }),
      h(Line, { label: 'explorer', value: s.explorerUrl, dim: true }),
      h(Line, { label: 'worker duration', value: s.durationMs != null ? `${s.durationMs}ms` : null }),
      h(Line, { label: 'tokens', value: fmtNum(s.tokens, 9) }),
      h(Line, { label: 'sol', value: fmtNum(s.sol, 9) }),
      h(Line, { label: 'totalFees (SOL)', value: fmtNum(s.totalFeesSol, 9) }),
      h(Line, { label: 'priceImpact', value: s.priceImpactPct != null ? `${fmtNum(s.priceImpactPct, 4)}%` : null }),
      failed ? h(Line, { label: 'error', value: s.errMessage || formatErrMessage(s.err), dim: false }) : null,
      (() => {
        const q = s.quote;
        if (!q || typeof q !== 'object') return null;

        const routePlan = Array.isArray(q.routePlan)
          ? q.routePlan
          : Array.isArray(q.route_plan)
            ? q.route_plan
            : Array.isArray(q.routes)
              ? q.routes
              : null;

        const routeSteps = routePlan ? routePlan.length : null;

        const slippage = pickQuoteField(q, ['slippageBps', 'slippage_bps', 'slippagePct', 'slippage_pct', 'slippage']);
        const minOut = pickQuoteField(q, ['otherAmountThreshold', 'other_amount_threshold', 'minOutAmount', 'min_out_amount']);
        const inAmt = pickQuoteField(q, ['inAmount', 'in_amount', 'inputAmount', 'input_amount']);
        const outAmt = pickQuoteField(q, ['outAmount', 'out_amount', 'outputAmount', 'output_amount']);

        const lines = [];
        if (routeSteps != null) {
          lines.push(h(Line, { label: 'route', value: `${routeSteps} step${routeSteps === 1 ? '' : 's'}`, dim: true }));
        }
        if (slippage != null) {
          lines.push(h(Line, { label: 'slippage', value: fmtSlippage(slippage), dim: true }));
        }
        if (minOut != null) {
          lines.push(h(Line, { label: 'min out', value: String(minOut), dim: true }));
        }
        if (inAmt != null) {
          lines.push(h(Line, { label: 'quote in', value: String(inAmt), dim: true }));
        }
        if (outAmt != null) {
          lines.push(h(Line, { label: 'quote out', value: String(outAmt), dim: true }));
        }

        return lines.length ? h(Box, { flexDirection: 'column', marginTop: 1 }, ...lines) : null;
      })()
    );
  }

  const { waitUntilExit } = render(h(App));
  await waitUntilExit();
}

async function createSwapProgressInkRenderer(context) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return null;

  const ink = await import('ink');
  const React = require('react');
  const { createTxSummaryCardComponents } = require('../tui/txSummaryCard');
  const h = React.createElement;

  const { render, Box, Text, useInput } = ink;
  const { useApp } = ink;
  const { useEffect, useMemo, useState } = React;
  const { TxSummaryCard } = createTxSummaryCardComponents(ink);

  const emitter = new EventEmitter();
  const uiContext = context && typeof context === 'object' ? context : null;

  function buildHeaderLine() {
    if (!uiContext) return null;
    const parts = [];
    if (uiContext.walletAlias) parts.push(`wallet=${uiContext.walletAlias}`);
    if (uiContext.mint) parts.push(`mint=${shorten(String(uiContext.mint), 8, 6)}`);
    if (uiContext.amount != null && uiContext.side) {
      parts.push(`amount=${uiContext.amount}`);
      parts.push(uiContext.side === 'buy' ? '(SOL → Token)' : '(Token → SOL)');
    }
    return parts.length ? parts.join(' | ') : null;
  }

  function formatProgressEventLabel(evt) {
    const e = String(evt || '');
    switch (e) {
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
        return e || 'progress';
    }
  }

  function normalizeProgressPayload(payload) {
    if (!payload) return { event: null, data: null, ts: Date.now() };
    if (typeof payload === 'string') return { event: payload, data: null, ts: Date.now() };
    if (payload.event) return payload;
    if (payload.type === 'progress' && payload.payload) {
      return normalizeProgressPayload(payload.payload);
    }
    if (payload.data && payload.data.event) {
      return { event: payload.data.event, data: payload.data, ts: payload.ts || Date.now() };
    }
    if (payload.name) {
      return { ...payload, event: payload.name };
    }
    return { event: payload.event || payload.step || payload.status || null, data: payload.data || null, ts: payload.ts || Date.now() };
  }
  const progressSteps = [
    { id: 'validated', label: 'Validate request' },
    { id: 'secret', label: 'Resolve wallet key' },
    { id: 'prepare', label: 'Prepare swap' },
    { id: 'submit', label: 'Submit transaction' },
    { id: 'monitor', label: 'Confirm transaction' },
  ];

  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(11, 19);
  }

  /**
   * Map worker progress events into ordered swap step states.
   * @param {Array<{event?:string}>} items
   * @param {object|null} summary
   * @returns {Array<{id:string,label:string,status:string}>}
   */
  function deriveStepState(items, summary) {
    const statusById = {};
    progressSteps.forEach((step) => {
      statusById[step.id] = 'pending';
    });
    let activeId = null;

    items.forEach((item) => {
      const event = item && item.event ? String(item.event) : '';
      switch (event) {
        case 'swap.build.start':
          statusById.prepare = 'active';
          activeId = 'prepare';
          break;
        case 'swap.build.done':
          statusById.prepare = 'done';
          activeId = 'submit';
          break;
        case 'swap.send.start':
          statusById.submit = 'active';
          activeId = 'submit';
          break;
        case 'swap.send.done':
          statusById.submit = 'done';
          activeId = 'monitor';
          break;
        case 'swap:validated':
          statusById.validated = 'done';
          activeId = 'secret';
          break;
        case 'swap:secret:resolved':
          statusById.secret = 'done';
          activeId = 'prepare';
          break;
        case 'swap:amount:resolve:start':
          statusById.prepare = 'active';
          activeId = 'prepare';
          break;
        case 'swap:amount:resolve:done':
          statusById.prepare = 'done';
          activeId = 'submit';
          break;
        case 'swap:engine:start':
          statusById.prepare = statusById.prepare === 'done' ? 'done' : 'active';
          activeId = 'prepare';
          break;
        case 'swap:submitted':
          statusById.submit = 'done';
          activeId = 'monitor';
          break;
        case 'swap:monitor:start':
          statusById.submit = 'done';
          statusById.monitor = 'active';
          activeId = 'monitor';
          break;
        case 'swap:monitor:done':
          statusById.submit = 'done';
          statusById.monitor = 'done';
          activeId = null;
          break;
        case 'swap:monitor:detached':
          statusById.submit = 'done';
          statusById.monitor = 'done';
          activeId = null;
          break;
        default:
          break;
      }
    });

    if (summary) {
      if (summary.status === 'failed') {
        statusById.monitor = 'failed';
      } else if (summary.status === 'ok' || summary.status === 'unknown') {
        statusById.monitor = 'done';
      }
      activeId = null;
    }

    if (!activeId && !summary) {
      const pending = progressSteps.find((step) => statusById[step.id] === 'pending');
      activeId = pending ? pending.id : null;
    }

    if (activeId && statusById[activeId] === 'pending') {
      statusById[activeId] = 'active';
    }

    return progressSteps.map((step) => ({
      id: step.id,
      label: step.label,
      status: statusById[step.id] || 'pending',
    }));
  }

  function App() {
    const { exit } = useApp();
    const [items, setItems] = useState([]);
    const [txSummary, setTxSummary] = useState(null);

    const title = useMemo(() => {
      if (txSummary && txSummary.label) return txSummary.label;
      if (!items.length) return 'Preparing swap…';
      const last = items[items.length - 1];
      return last && last.event ? formatProgressEventLabel(last.event) : 'Swap progress';
    }, [items, txSummary]);

    const steps = useMemo(() => deriveStepState(items, txSummary), [items, txSummary]);

    const progressLine = useMemo(() => {
      const total = steps.length;
      const doneCount = steps.filter((step) => step.status === 'done').length;
      const failedCount = steps.filter((step) => step.status === 'failed').length;
      const effectiveDone = Math.min(total, doneCount + failedCount);
      const width = 28;
      const filled = total ? Math.round((effectiveDone / total) * width) : 0;
      const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
      const pct = total ? Math.round((effectiveDone / total) * 100) : 0;
      return failedCount ? `[${bar}] ${pct}% (failed)` : `[${bar}] ${pct}%`;
    }, [steps]);

    useEffect(() => {
      const onProgress = (payload) => {
        const normalized = normalizeProgressPayload(payload);
        setItems((prev) => {
          const next = prev.concat(normalized);
          return next.length > 8 ? next.slice(-8) : next;
        });
      };
      const onSummary = (payload) => {
        setTxSummary(payload || null);
      };
      emitter.on('progress', onProgress);
      emitter.once('summary', onSummary);
      return () => {
        emitter.off('progress', onProgress);
        emitter.off('summary', onSummary);
      };
    }, []);

    useInput((input, key) => {
      if (!txSummary) return;
      if (key.escape || key.return || input === 'q' || input === 'Q') {
        exit();
      }
    });

    useEffect(() => {
      if (!txSummary) return undefined;
      const timer = setTimeout(() => exit(), 8000);
      return () => clearTimeout(timer);
    }, [txSummary, exit]);

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { bold: true }, title),
      buildHeaderLine() ? h(Text, { dimColor: true }, buildHeaderLine()) : null,
      txSummary
        ? h(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            h(TxSummaryCard, { summary: txSummary }),
            h(Text, { dimColor: true }, 'Press Enter, q, or Esc to exit')
          )
        : h(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            h(Text, { color: 'cyan' }, progressLine),
            h(
              Box,
              { flexDirection: 'column', marginTop: 1 },
              ...steps.map((step) => {
                const status =
                  step.status === 'done'
                    ? { icon: '[x]', color: 'green', dim: false }
                    : step.status === 'active'
                      ? { icon: '[>]', color: 'yellow', dim: false }
                      : step.status === 'failed'
                        ? { icon: '[!]', color: 'red', dim: false }
                        : { icon: '[ ]', color: undefined, dim: true };
                return h(
                  Text,
                  { key: step.id, color: status.color, dimColor: status.dim },
                  `${status.icon} ${step.label}`
                );
              })
            ),
            items.length
              ? h(
                  Box,
                  { flexDirection: 'column', marginTop: 1 },
                  ...items.map((p, idx) => {
                    const label = p && p.event ? formatProgressEventLabel(p.event) : 'progress';
                    const stamp = fmtTs(p && p.ts);
                    const suffix =
                      p && p.data && typeof p.data === 'object' && p.data.txid ? ` txid=${shorten(p.data.txid)}` : '';
                    return h(Text, { key: `${idx}-${label}` }, `${stamp ? `[${stamp}] ` : ''}${label}${suffix}`);
                  })
                )
              : h(Text, { dimColor: true }, 'Waiting for worker…')
          ),
    );
  }

  const instance = render(h(App), { exitOnCtrlC: false });
  return {
    emitProgress: (payload) => emitter.emit('progress', payload),
    setSummary: (summary) => emitter.emit('summary', summary),
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

async function resolveWalletRecord(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('A wallet alias or address is required. Use --wallet <alias>');
  }
  const resolution = await walletResolver.resolveAliasOrAddress(trimmed);
  if (!resolution || !resolution.wallet) {
    throw new Error(
      `Wallet "${trimmed}" not found in registry. Use 'scoundrel warchest --help' to import wallets.`,
    );
  }
  const wallet = resolution.wallet;
  if (!wallet.alias) {
    throw new Error(
      `Wallet "${trimmed}" is not registered with an alias. Register it via the warchest CLI before trading.`,
    );
  }
  if (!wallet.hasPrivateKey) {
    throw new Error(`Wallet "${wallet.alias}" does not have a private key available for swaps.`);
  }
  const walletId = wallet.walletId !== undefined ? wallet.walletId : wallet.wallet_id;
  if (walletId == null) {
    throw new Error(`Wallet "${wallet.alias}" is missing a walletId; re-import it via the warchest CLI.`);
  }
  if (!wallet.pubkey) {
    throw new Error(`Wallet "${wallet.alias}" is missing a pubkey; re-import it via the warchest CLI.`);
  }
  return wallet;
}

/**
 * Glue layer between the Commander `swap` command and the swap worker.
 * This mirrors summonTheWarlord's `trade` UX while delegating swap
 * execution to the warchest swap worker.
 *
 * @param {string} mint
 * @param {object} opts Commander options
 * @param {string} opts.wallet
 * @param {string|number} [opts.buy]
 * @param {string|number} [opts.sell]
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<void>}
 */
module.exports = async function tradeCli(mint, opts) {
  const swapLogger = logger.swap ? logger.swap() : logger;
  const side = opts.buy ? 'buy' : (opts.sell ? 'sell' : null);

  if (!side) {
    throw new Error('You must specify exactly one of --buy or --sell.');
  }
  if (opts.buy && opts.sell) {
    throw new Error('Use either --buy or --sell, not both.');
  }

  const trimmedMint = String(mint || '').trim();
  if (!isValidMint(trimmedMint)) {
    throw new Error(`Invalid mint address: ${trimmedMint}`);
  }

  let walletAliasOrAddress = opts.wallet;
  if (!walletAliasOrAddress) {
    const selection = await selectWalletInteractively({
      promptLabel: '[scoundrel:swap] Select a wallet to trade with:',
      allowOther: false,
    });
    if (!selection || !selection.walletLabel) {
      throw new Error(
        'No wallets are available in the registry. Use `scoundrel warchest add` to import one.',
      );
    }
    walletAliasOrAddress = selection.walletLabel;
    logger.info(`[scoundrel:swap] Using wallet ${walletAliasOrAddress}`);
  }

  const resolvedWallet = await resolveWalletRecord(walletAliasOrAddress);
  const walletAlias = resolvedWallet.alias;
  const walletPubkey = resolvedWallet.pubkey;
  const walletId = resolvedWallet.walletId !== undefined ? resolvedWallet.walletId : resolvedWallet.wallet_id;

  const rawAmount = side === 'buy' ? opts.buy : opts.sell;
  const amount = normalizeAmount(side, rawAmount);

  if (!isWarchestServiceRunning()) {
    logger.warn(
      `[scoundrel:swap] warchest service PID not detected at ${WARCHEST_PID_FILE}; ` +
        'HUD/HUD persistence may be degraded.',
    );
  }

  const dryRun = Boolean(opts.dryRun);
  const detachMonitor = Boolean(opts.detach);
  const payload = {
    side,
    mint: trimmedMint,
    amount,
    walletAlias,
    walletId,
    walletPubkey,
    dryRun,
    // When the CLI normalizes "-s", "-s auto", or "-s 100%" into a full-balance
    // panic dump, it sets opts._panic = true. We pass this through so the
    // swap worker can treat it as an explicit "dump everything now" signal.
    panic: Boolean(opts._panic),
    detachMonitor,
  };

  const displayAmount =
    typeof amount === 'number' ? amount.toLocaleString(undefined, { maximumFractionDigits: 6 }) : amount;
  const flowLabel = side === 'buy' ? 'SOL → Token' : 'Token → SOL';
  const externalProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const shouldUseInk = Boolean(!opts.noInk && process.stdout.isTTY && process.stdin.isTTY);
  const queuedMessage = `[scoundrel:swap] 🚀 ${side.toUpperCase()} queued | wallet=${walletAlias} | mint=${trimmedMint} | amount=${displayAmount} (${flowLabel})`;
  swapLogger.info(queuedMessage);

  const rpcEndpoint =
    process.env.SOLANATRACKER_RPC_HTTP_URL ||
    undefined;
  const progressUi = shouldUseInk
    ? await createSwapProgressInkRenderer({
        side,
        walletAlias,
        mint: trimmedMint,
        amount: displayAmount,
      })
    : null;
  const emitProgress = (payload) => {
    if (progressUi) progressUi.emitProgress(payload);
    if (externalProgress) externalProgress(payload);
  };
  let usedInkUi = false;
  const restoreLogging = progressUi ? muteStdoutLogging(logger) : null;
  const restoreInkGuards = progressUi
    ? installSwapInkGuards({
        progressUi,
        restoreLogging,
        side,
        mint: trimmedMint,
        log: swapLogger,
      })
    : null;

  const captureOutput = Boolean(
    progressUi ||
    externalProgress ||
    opts.noInk ||
    process.env.SC_INK_MODE === '1'
  );

  const env = buildWorkerEnv({
    rpcEndpoint,
    dataEndpoint: process.env.SOLANATRACKER_DATA_ENDPOINT,
    walletIds: null,
    inkMode: Boolean(progressUi),
    extraEnv: {
      ...(rpcEndpoint
        ? {
            SOLANATRACKER_RPC_HTTP_URL: rpcEndpoint,
          }
        : {}),
      ...(progressUi ? { LOG_LEVEL: 'error' } : {}),
    },
  });

  let workerResponse;
  let finalPayload = null;
  const hub = getHubCoordinator();
  try {
    workerResponse = await hub.runSwap(payload, {
      env,
      timeoutMs: 120_000,
      captureOutput,
      onProgress: (p) => {
        emitProgress(p);
      },
    });
  } catch (err) {
    logSwapFailure(swapLogger, err, { stage: 'swapWorker', side, mint: trimmedMint });
    // If Ink is active, render a failure summary and exit cleanly.
    if (progressUi) {
      usedInkUi = true;
      progressUi.setSummary(
        buildSwapErrorSummary({
          err,
          side,
          mint: trimmedMint,
          label: `${side.toUpperCase()} swap failed`,
        })
      );
      try {
        await progressUi.waitUntilExit();
      } finally {
        progressUi.unmount();
        if (restoreLogging) restoreLogging();
      }
    }
    throw err;
  }

  try {
    const result = workerResponse && workerResponse.result ? workerResponse.result : workerResponse;

    if (!result) {
      swapLogger.info('[scoundrel:swap] swap completed, but worker returned no summary.');
      if (progressUi) {
        usedInkUi = true;
        progressUi.setSummary({
          kind: 'swap',
          status: 'unknown',
          label: `${side.toUpperCase()} swap submitted`,
          side,
          mint: trimmedMint,
          txid: null,
          explorerUrl: null,
          err: null,
          errMessage: '',
        });
        try {
          await progressUi.waitUntilExit();
        } finally {
          progressUi.unmount();
          if (restoreLogging) restoreLogging();
        }
      }
      finalPayload = { result: null, monitorResult: null, txSummary: null };
      return finalPayload;
    }

    const {
      txid,
      signature,
      side: finalSide,
      tokensReceivedDecimal,
      solReceivedDecimal,
      totalFees,
      priceImpact,
      quote,
      timing,
    } = result;

    if (dryRun) {
      logger.info('[scoundrel] (dry run) swap request prepared:');
      logger.info(JSON.stringify({ result }, null, 2));
      finalPayload = { result, monitorResult: null, txSummary: null };
      return finalPayload;
    }

    let monitorResult = result.monitor || null;
    const monitorPayload = result.monitorPayload || null;
    const monitorDetach = Boolean(result.monitorDetach);

    if (!monitorResult && monitorPayload) {
      const monitorEnv = { ...env };
      if (monitorPayload.rpcEndpoint && !monitorEnv.SOLANATRACKER_RPC_HTTP_URL) {
        monitorEnv.SOLANATRACKER_RPC_HTTP_URL = monitorPayload.rpcEndpoint;
      }
      if (monitorDetach) {
        try {
          monitorResult = await hub.runTxMonitor(monitorPayload, {
            env: monitorEnv,
            detached: true,
            payloadFileDir: path.join(process.cwd(), 'data', 'warchest', 'tx-monitor-requests'),
            captureOutput,
          });
          emitProgress({ event: 'swap:monitor:detached' });
        } catch (err) {
          swapLogger.warn(`[scoundrel:swap] swap monitor detach failed: ${err?.message || err}`);
        }
      } else {
        emitProgress({ event: 'swap:monitor:start' });
        try {
          monitorResult = await hub.runTxMonitor(monitorPayload, {
            env: monitorEnv,
            timeoutMs: 120_000,
            captureOutput,
          });
        } catch (err) {
          swapLogger.warn(`[scoundrel:swap] swap monitor failed: ${err?.message || err}`);
        } finally {
          emitProgress({
            event: 'swap:monitor:done',
            data: { status: monitorResult && monitorResult.status ? monitorResult.status : null },
          });
        }
      }
    }
    if (monitorResult) {
      result.monitor = monitorResult;
    }
    if (monitorResult && monitorResult.detached) {
      swapLogger.info('[scoundrel:swap] swap monitoring detached; confirmation/persistence will continue in background.');
    } else if (txid) {
      emitProgress({
        ts: Date.now(),
        event: 'swap:submitted',
        data: { txid },
      });
      if (!progressUi) {
        swapLogger.info(`[scoundrel:swap] 🛰️ Submitted transaction ${txid}; awaiting confirmation…`);
      }
    }
    const explorerBaseUrl =
      result && result.monitorPayload && result.monitorPayload.explorerBaseUrl
        ? result.monitorPayload.explorerBaseUrl
        : null;
    const txSummary = (monitorResult && monitorResult.txSummary && typeof monitorResult.txSummary === 'object')
      ? monitorResult.txSummary
      : buildTxSummaryFromSwapResult({ result, monitorResult, side, explorerBaseUrl });

    if (progressUi) {
      usedInkUi = true;
      progressUi.setSummary(txSummary);
      try {
        await progressUi.waitUntilExit();
      } finally {
        progressUi.unmount();
        if (restoreLogging) restoreLogging();
      }
    }

    // Concise operator logs (fallback when Ink is unavailable or fails).
    if (!usedInkUi) {
      const statusPrefix = txSummary.status === 'ok' ? '✅' : txSummary.status === 'failed' ? '❌' : '⚠️';
      logger.info(`\n[scoundrel] ${statusPrefix} ${txSummary.label || 'swap result'}`);
      if (txSummary.txid) {
        logger.info(`  txid: ${txSummary.txid}`);
        logger.info(`  explorer: ${txSummary.explorerUrl || `https://solscan.io/tx/${txSummary.txid}`}`);
      }
      if (txSummary.durationMs != null) {
        logger.info(`  worker duration: ${txSummary.durationMs}ms`);
      }
      if (txSummary.tokens != null) {
        logger.info(`  tokens: ${txSummary.tokens}`);
      }
      if (txSummary.sol != null) {
        logger.info(`  sol: ${txSummary.sol}`);
      }
      if (txSummary.totalFeesSol != null) {
        logger.info(`  totalFees (SOL): ${txSummary.totalFeesSol}`);
      }
      if (txSummary.priceImpactPct != null) {
        logger.info(`  priceImpact: ${txSummary.priceImpactPct}`);
      }
      if (txSummary.status === 'failed' && (txSummary.errMessage || txSummary.err)) {
        logger.info(`  error: ${txSummary.errMessage || formatErrMessage(txSummary.err)}`);
      }
    }

    finalPayload = { result, monitorResult, txSummary };

    if (!monitorResult) {
      swapLogger.warn('[scoundrel:swap] swap confirmation worker did not return a status; monitor the transaction manually.');
      return finalPayload;
    }

    if (monitorResult.status === 'failed') {
      const errPayload =
        typeof monitorResult.err === 'object'
          ? JSON.stringify(monitorResult.err)
          : monitorResult.err;
      throw new Error(
        `Swap transaction ${txid || signature || 'unknown'} failed${errPayload ? `: ${errPayload}` : ''}`,
      );
    }

    if (monitorResult.status === 'timeout') {
      swapLogger.warn('[scoundrel:swap] confirmation timed out; verify the transaction manually.');
    }

    return finalPayload;
  } finally {
    if (progressUi && !usedInkUi) {
      try {
        progressUi.unmount();
      } catch (_) {
        // ignore
      }
      if (restoreLogging) {
        try {
          restoreLogging();
        } catch (_) {
          // ignore
        }
      }
    }
    if (restoreInkGuards) {
      restoreInkGuards();
    }
  }

  return finalPayload;
};
