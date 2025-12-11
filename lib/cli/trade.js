const path = require('path');
const logger = require('../logger');
const chalk = require('chalk');
const { forkWorkerWithPayload, buildWorkerEnv } = require('../warchest/workers/harness');
const { loadConfig } = require('../swap/swapConfig');
const { createWalletResolver } = require('../wallets/resolver');
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

  const walletAliasOrAddress = opts.wallet;
  if (!walletAliasOrAddress) {
    throw new Error('A wallet alias or address is required. Use --wallet <alias>.');
  }

  const resolvedWallet = await resolveWalletRecord(walletAliasOrAddress);
  const walletAlias = resolvedWallet.alias;
  const walletPubkey = resolvedWallet.pubkey;
  const walletId = resolvedWallet.walletId !== undefined ? resolvedWallet.walletId : resolvedWallet.wallet_id;

  const rawAmount = side === 'buy' ? opts.buy : opts.sell;
  const amount = normalizeAmount(side, rawAmount);

  const swapConfig = await loadConfig();
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
    useJito,
    dryRun,
    // When the CLI normalizes "-s", "-s auto", or "-s 100%" into a full-balance
    // panic dump, it sets opts._panic = true. We pass this through so the
    // swap worker can treat it as an explicit "dump everything now" signal.
    panic: Boolean(opts._panic),
  };

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

  const monitorResult = result.monitor || null;
  let statusPrefix = '🚀';
  let statusSummary = 'swap submitted';
  if (monitorResult && monitorResult.status === 'confirmed') {
    statusPrefix = '✅';
    statusSummary = 'swap confirmed';
  } else if (monitorResult && monitorResult.status === 'failed') {
    statusPrefix = '❌';
    statusSummary = 'swap failed';
  } else if (monitorResult && monitorResult.status === 'timeout') {
    statusPrefix = '⚠️';
    statusSummary = 'swap confirmation timed out';
  }

  logger.info(`\n[scoundrel] ${statusPrefix} ${finalSide || side} ${statusSummary}`);
  if (txid) {
    logger.info(`  txid: ${txid}`);
    logger.info(`  explorer: https://solscan.io/tx/${txid}`);
  }
  if (signature && signature !== txid) {
    logger.info(`  signature: ${signature}`);
  }
  if (timing && typeof timing.durationMs === 'number') {
    logger.info(`  worker duration: ${timing.durationMs}ms`);
  }
  if (tokensReceivedDecimal !== undefined) {
    logger.info(`  tokens: ${tokensReceivedDecimal}`);
  }
  if (solReceivedDecimal !== undefined) {
    logger.info(`  sol: ${solReceivedDecimal}`);
  }
  if (totalFees !== undefined) {
    logger.info(`  totalFees (SOL): ${totalFees}`);
  }
  if (priceImpact !== undefined) {
    logger.info(`  priceImpact: ${priceImpact}`);
  }
  if (quote && typeof quote === 'object') {
    logger.info('  quote:', JSON.stringify(quote, null, 2));
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
