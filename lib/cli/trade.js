const path = require('path');
const logger = require('../logger');
const chalk = require('chalk');
const { forkWorkerWithPayload, buildWorkerEnv } = require('../warchest/workers/harness');
const { loadConfig } = require('../swap/swapConfig');
const { createWalletResolver } = require('../wallets/resolver');
const { selectWalletInteractively } = require('../wallets/walletSelection');
const { isWarchestServiceRunning, WARCHEST_PID_FILE } = require('../warchest/daemonStatus');

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

function normalizeBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return false;
}

function normalizePriorityFeeLevelConfig(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const map = {
    min: 'min',
    low: 'low',
    medium: 'medium',
    high: 'high',
    veryhigh: 'veryHigh',
    'very-high': 'veryHigh',
    unsafe: 'unsafeMax',
    unsafemax: 'unsafeMax',
    'unsafe-max': 'unsafeMax',
  };
  return map[trimmed] || undefined;
}

function normalizeTxVersionConfig(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'legacy') return 'legacy';
  if (trimmed === 'v0' || trimmed === '0' || trimmed === 'versioned') return 'v0';
  return undefined;
}

function buildExplorerUrl(txid) {
  const base = process.env.SOLANA_EXPLORER_BASE_URL || 'https://solscan.io/tx';
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

function buildTxSummaryFromSwapResult({ result, monitorResult, side }) {
  const txid = result.txid || result.signature || null;
  const confirmed = monitorResult && monitorResult.status === 'confirmed';
  const failed = monitorResult && monitorResult.status === 'failed';
  const timedOut = monitorResult && monitorResult.status === 'timeout';

  const status = confirmed ? 'ok' : failed ? 'failed' : timedOut ? 'unknown' : 'unknown';

  const err = failed ? (monitorResult.err || null) : null;
  const errMessage = failed ? formatErrMessage(err) : '';

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
    explorerUrl: buildExplorerUrl(txid),
    durationMs: result.timing && typeof result.timing.durationMs === 'number' ? result.timing.durationMs : null,

    tokens: Object.prototype.hasOwnProperty.call(result, 'tokensReceivedDecimal') ? result.tokensReceivedDecimal : null,
    sol: Object.prototype.hasOwnProperty.call(result, 'solReceivedDecimal') ? result.solReceivedDecimal : null,
    totalFeesSol: Object.prototype.hasOwnProperty.call(result, 'totalFees') ? result.totalFees : null,
    priceImpactPct: Object.prototype.hasOwnProperty.call(result, 'priceImpact') ? result.priceImpact : null,
    quote: result.quote && typeof result.quote === 'object' ? result.quote : null,

    err,
    errMessage,
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
 * Glue layer between the Commander `swap` command and the swap engine.
 * This mirrors summonTheWarlord's `trade` UX while delegating all
 * swap details to lib/swapEngine.js.
 *
 * @param {string} mint
 * @param {object} opts Commander options
 * @param {string} opts.wallet
 * @param {string|number} [opts.buy]
 * @param {string|number} [opts.sell]
 * @param {string|number} [opts.slippage]
 * @param {string|number} [opts.priorityFee]
 * @param {boolean} [opts.jito]
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<void>}
 */
module.exports = async function tradeCli(mint, opts) {
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

  const swapConfig = await loadConfig();
  const configPriorityFeeLevel = normalizePriorityFeeLevelConfig(
    swapConfig && swapConfig.priorityFeeLevel ? String(swapConfig.priorityFeeLevel) : undefined,
  );
  const configTxVersion = normalizeTxVersionConfig(
    swapConfig && swapConfig.txVersion ? String(swapConfig.txVersion) : undefined,
  );
  const showQuoteDetails = normalizeBooleanFlag(swapConfig && swapConfig.showQuoteDetails);
  const debugLogging = normalizeBooleanFlag(swapConfig && swapConfig.DEBUG_MODE);
  if (!isWarchestServiceRunning()) {
    logger.warn(
      `[scoundrel:swap] warchest service PID not detected at ${WARCHEST_PID_FILE}; ` +
        'HUD/HUD persistence may be degraded.',
    );
  }

  // ---- slippage handling (default 15%) ----
  let slippagePercent;
  if (opts.slippage !== undefined && opts.slippage !== null) {
    slippagePercent = Number(opts.slippage);
    if (!Number.isFinite(slippagePercent) || slippagePercent <= 0) {
      throw new Error('Slippage must be a positive number (percent).');
    }
  } else {
    // Default slippage when not provided by the user: prefer swap config, then hard-coded 15%.
    const cfgSlip =
      swapConfig && swapConfig.slippage !== undefined
        ? Number(swapConfig.slippage)
        : swapConfig && swapConfig.slippagePercent !== undefined
          ? Number(swapConfig.slippagePercent)
          : undefined;

    if (cfgSlip !== undefined && Number.isFinite(cfgSlip) && cfgSlip > 0) {
      slippagePercent = cfgSlip;
    } else {
      slippagePercent = 15;
      logger.debug(
        chalk.bgYellow('[scoundrel:swap] slippage undefined and no valid config default; defaulting to 15%'),
      );
    }
  }

  // ---- priorityFee handling (optional) ----
  let priorityFee;
  if (opts.priorityFee !== undefined && opts.priorityFee !== null) {
    const raw = String(opts.priorityFee).trim().toLowerCase();
    if (raw === 'auto') {
      priorityFee = 'auto';
    } else {
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error('priority-fee must be a non-negative number or "auto"');
      }
      priorityFee = num;
    }
  } else {
    const cfgPriority =
      swapConfig && swapConfig.priorityFee !== undefined
        ? Number(swapConfig.priorityFee)
        : swapConfig && swapConfig.defaultPriorityFee !== undefined
          ? Number(swapConfig.defaultPriorityFee)
          : undefined;

    if (cfgPriority !== undefined && Number.isFinite(cfgPriority) && cfgPriority >= 0) {
      priorityFee = cfgPriority;
    } else {
      logger.debug(
        chalk.bgYellow(
          '[scoundrel:swap] priorityFee undefined and no valid config default; using solana-swap default behavior',
        ),
      );
    }
  }

  // ---- useJito handling (optional) ----
  let useJito;
  if (Object.prototype.hasOwnProperty.call(opts, 'jito')) {
    useJito = Boolean(opts.jito);
  } else {
    let cfgJito;
    if (swapConfig && Object.prototype.hasOwnProperty.call(swapConfig, 'useJito')) {
      cfgJito = Boolean(swapConfig.useJito);
    } else if (swapConfig && Object.prototype.hasOwnProperty.call(swapConfig, 'jito')) {
      cfgJito = Boolean(swapConfig.jito);
    }

    if (cfgJito !== undefined) {
      useJito = cfgJito;
    } else {
      logger.debug(
        chalk.bgYellow(
          '[scoundrel:swap] jito flag undefined and no config default; using solana-swap default behavior',
        ),
      );
    }
  }

  const dryRun = Boolean(opts.dryRun);
  const workerPath = path.join(__dirname, '..', 'warchest', 'workers', 'swapWorker.js');
  const payload = {
    side,
    mint: trimmedMint,
    amount,
    walletAlias,
    walletId,
    walletPubkey,
    slippagePercent,
    priorityFee,
    priorityFeeLevel: configPriorityFeeLevel || null,
    txVersion: configTxVersion || null,
    showQuoteDetails,
    debugLogging,
    useJito,
    dryRun,
    // When the CLI normalizes "-s", "-s auto", or "-s 100%" into a full-balance
    // panic dump, it sets opts._panic = true. We pass this through so the
    // swap worker can treat it as an explicit "dump everything now" signal.
    panic: Boolean(opts._panic),
  };

  const displayAmount =
    typeof amount === 'number' ? amount.toLocaleString(undefined, { maximumFractionDigits: 6 }) : amount;
  const flowLabel = side === 'buy' ? 'SOL → Token' : 'Token → SOL';
  console.log(
    chalk.cyan(
      `[scoundrel:swap] 🚀 ${side.toUpperCase()} queued | wallet=${walletAlias} | mint=${trimmedMint} | amount=${displayAmount} (${flowLabel}) | slippage=${slippagePercent}% | priority=${
        payload.priorityFeeLevel || 'auto'
      }`
    )
  );

  const rpcEndpoint =
    process.env.SOLANATRACKER_RPC_HTTP_URL ||
    process.env.SOLANA_RPC_URL ||
    swapConfig?.rpcUrl;
  const swapApiKey =
    process.env.SOLANATRACKER_API_KEY ||
    process.env.SWAP_API_KEY ||
    swapConfig?.swapAPIKey;

  const env = buildWorkerEnv({
    rpcEndpoint,
    dataEndpoint: process.env.SOLANATRACKER_DATA_ENDPOINT,
    walletIds: null,
    extraEnv: {
      ...(rpcEndpoint
        ? {
            SOLANATRACKER_RPC_HTTP_URL: rpcEndpoint,
            SOLANA_RPC_URL: rpcEndpoint,
          }
        : {}),
      ...(swapApiKey
        ? {
            SOLANATRACKER_API_KEY: swapApiKey,
            SWAP_API_KEY: swapApiKey,
          }
        : {}),
    },
  });

  const { result } = await forkWorkerWithPayload(workerPath, {
    payload,
    env,
    timeoutMs: 120_000,
  });

  if (!result) {
    logger.info('[scoundrel] swap completed, but worker returned no summary.');
    return;
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
    return;
  }

  if (txid) {
    console.log(chalk.cyan(`[scoundrel:swap] 🛰️ Submitted transaction ${txid}; awaiting confirmation…`));
  }

  const monitorResult = result.monitor || null;
  const txSummary = (monitorResult && monitorResult.txSummary && typeof monitorResult.txSummary === 'object')
    ? monitorResult.txSummary
    : buildTxSummaryFromSwapResult({ result, monitorResult, side });

  // Prefer a standard card-friendly summary object (from txMonitor when available).
  let inkRendered = false;
  if (process.stdout.isTTY && process.stdin.isTTY) {
    try {
      await renderTxSummaryCardInk(txSummary);
      inkRendered = true;
    } catch (err) {
      // If Ink fails for any reason, fall back to concise text logs.
      logger.debug(`[scoundrel:swap] Ink summary render failed: ${err?.message || String(err)}`);
    }
  }

  // Concise operator logs (fallback when Ink is unavailable or fails).
  if (!inkRendered) {
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

  if (!monitorResult) {
    logger.warn('[scoundrel] swap confirmation worker did not return a status; monitor the transaction manually.');
    return;
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
    logger.warn('[scoundrel] confirmation timed out; verify the transaction manually.');
  }
};
