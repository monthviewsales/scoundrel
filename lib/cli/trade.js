const logger = require('../logger');
const chalk = require('chalk');
const swapEngine = require('../swap/swapEngine');
const getWalletForSwap = require('../wallets/getWalletForSwap');

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

/**
 * Glue layer between the Commander `trade` command and the swap engine.
 * This mirrors summonTheWarlord's `trade` UX while delegating all
 * swap details to lib/swap/swapEngine.js.
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
    throw new Error('A wallet alias or address is required. Use --wallet <aliasOrAddress>.');
  }

  const rawAmount = side === 'buy' ? opts.buy : opts.sell;
  const amount = normalizeAmount(side, rawAmount);

  // ---- slippage handling (default 15%) ----
  let slippagePercent;
  if (opts.slippage !== undefined && opts.slippage !== null) {
    slippagePercent = Number(opts.slippage);
    if (!Number.isFinite(slippagePercent) || slippagePercent <= 0) {
      throw new Error('Slippage must be a positive number (percent).');
    }
  } else {
    // Default slippage when not provided by the user.
    slippagePercent = 15;
    logger.debug(chalk.bgYellow('[scoundrel:trade] slippage undefined; defaulting to 15%'));
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
    logger.debug(chalk.bgYellow('[scoundrel:trade] priorityFee undefined; using solana-swap default behavior'));
  }

  // ---- useJito handling (optional) ----
  let useJito;
  if (Object.prototype.hasOwnProperty.call(opts, 'jito')) {
    useJito = Boolean(opts.jito);
  } else {
    logger.debug(chalk.bgYellow('[scoundrel:trade] jito flag undefined; using solana-swap default behavior'));
  }

  const dryRun = Boolean(opts.dryRun);

  // Resolve wallet (warchest / registry) into a signer + pubkey.
  const wallet = await getWalletForSwap(walletAliasOrAddress);
  if (!wallet || !wallet.keypair || !wallet.pubkey) {
    throw new Error('getWalletForSwap() must return { keypair, pubkey }');
  }

  const request = {
    side,
    mint: trimmedMint,
    amount,
    walletPubkey: wallet.pubkey,
    keypair: wallet.keypair,
    slippagePercent,
    dryRun,
  };

  if (priorityFee !== undefined) {
    request.priorityFee = priorityFee;
  }
  if (useJito !== undefined) {
    request.useJito = useJito;
  }

  const result = await swapEngine.performTrade(request);

  // Basic CLI output; richer formatting can be added later.
  if (dryRun) {
    // Expect the engine to include an expectedOut or quote field for dry runs.
    logger.info('[scoundrel] (dry run) trade request prepared:');
    logger.info(JSON.stringify({ request, result }, null, 2));
    return;
  }

  if (!result) {
    logger.info('[scoundrel] trade completed, but engine returned no summary.');
    return;
  }

  const {
    txid,
    side: finalSide,
    tokensReceivedDecimal,
    solReceivedDecimal,
    totalFees,
    priceImpact,
    quote,
  } = result;

  logger.info(`\n[scoundrel] ✅ ${finalSide || side} complete`);
  if (txid) {
    logger.info(`  txid: ${txid}`);
    logger.info(`  explorer: https://solscan.io/tx/${txid}`);
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
};