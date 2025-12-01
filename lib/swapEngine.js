const { SolanaTracker } = require('solana-swap');
const chalk = require('chalk');
const logger = require('./logger');
const { ensureTokenInfo } = require('./tokenInfoService');

let BootyBox;
try {
  // Adjust the path to BootyBox if needed in this project.
  BootyBox = require('../BootyBox');
} catch (err) {
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      '[swapEngine] BootyBox module not found; pending swap guards and position tracking are disabled:',
      err?.message || err,
    );
  }
}

// Wrapped SOL mint used by Solana Swap API
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * @typedef {Object} TradeRequest
 * @property {'buy'|'sell'} side
 * @property {string} mint                  // SPL mint to buy/sell
 * @property {number|string} amount         // number, 'auto', or '<percent>%'
 * @property {string} walletPubkey          // base58 public key
 * @property {import('@solana/web3.js').Keypair} keypair
 * @property {number} slippagePercent       // integer percent (e.g. 15)
 * @property {number|string} [priorityFee]  // number in SOL units or 'auto'
 * @property {boolean} [useJito]
 * @property {boolean} [dryRun]
 */

/**
 * @typedef {Object} TradeResult
 * @property {string|null} txid
 * @property {'buy'|'sell'} side
 * @property {number|undefined} [tokensReceivedDecimal]
 * @property {number|undefined} [solReceivedDecimal]
 * @property {number|undefined} [totalFees]
 * @property {number|undefined} [priceImpact]
 * @property {object|undefined} [quote]
 * @property {boolean} [dryRun]
 */

/**
 * Construct a SolanaTracker client from environment variables and a keypair.
 * Uses SOLANATRACKER_RPC_HTTP_URL as the canonical RPC endpoint and
 * SOLANATRACKER_API_KEY (or SWAP_API_KEY) for authentication.
 *
 * @param {import('@solana/web3.js').Keypair} keypair
 * @returns {SolanaTracker}
 */
function createSwapClient(keypair) {
  const rpcUrl = process.env.SOLANATRACKER_RPC_HTTP_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error('SOLANATRACKER_RPC_HTTP_URL (or SOLANA_RPC_URL) must be set for swap engine.');
  }

  const apiKey = process.env.SOLANATRACKER_API_KEY || process.env.SWAP_API_KEY;

  logger.debug(
    chalk.gray(
      `[swapEngine] Using RPC URL ${rpcUrl} with API key ${apiKey ? 'present' : 'absent'}`
    )
  );

  return new SolanaTracker(keypair, rpcUrl, apiKey);
}

/**
 * Internal helper to extract a rate/quote object from a swap response.
 * The solana-swap SDK returns `{ txn, rate, timeTaken, type }` for
 * getSwapInstructions. We prefer `rate`, but fall back gracefully.
 *
 * @param {any} swapResp
 * @returns {any}
 */
function extractRate(swapResp) {
  if (!swapResp || typeof swapResp !== 'object') return undefined;
  if (swapResp.rate) return swapResp.rate;
  if (swapResp.quote) return swapResp.quote;
  return swapResp;
}

/**
 * Perform a token trade using the Solana Swap SDK.
 * Mirrors summonTheWarlord semantics at a high level while keeping
 * specifics configurable via the TradeRequest shape.
 *
 * @param {TradeRequest} request
 * @returns {Promise<TradeResult>}
 */
async function performTrade(request) {
  const {
    side,
    mint,
    amount,
    walletPubkey,
    keypair,
    slippagePercent,
    priorityFee,
    useJito,
    dryRun,
  } = request || {};

  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`Invalid side: ${side}. Expected 'buy' or 'sell'.`);
  }
  if (!mint) {
    throw new Error('TradeRequest.mint is required.');
  }
  if (amount === undefined || amount === null) {
    throw new Error('TradeRequest.amount is required.');
  }
  if (!walletPubkey) {
    throw new Error('TradeRequest.walletPubkey is required.');
  }
  if (!keypair) {
    throw new Error('TradeRequest.keypair is required.');
  }
  if (!Number.isFinite(slippagePercent) || slippagePercent <= 0) {
    throw new Error('TradeRequest.slippagePercent must be a positive number.');
  }

  const hasPendingSwapHelpers =
    !!BootyBox &&
    typeof BootyBox.isSwapPending === 'function' &&
    typeof BootyBox.markPendingSwap === 'function' &&
    typeof BootyBox.clearPendingSwap === 'function';

  if (hasPendingSwapHelpers && BootyBox.isSwapPending(mint)) {
    throw new Error(`Swap already pending for mint ${mint}`);
  }

  if (hasPendingSwapHelpers) {
    BootyBox.markPendingSwap(mint);
  }

  try {
    // Best-effort metadata warmup: make sure we have token info cached locally.
    // The tokenInfoService is responsible for talking to the Data API and
    // BootyBox; failures here should never block a swap.
    try {
      await ensureTokenInfo({ mint });
    } catch (err) {
      logger.warn(
        '[swapEngine] ensureTokenInfo failed before trade; proceeding without cached metadata:',
        err?.message || err,
      );
    }

    const tracker = createSwapClient(keypair);

    const fromMint = side === 'buy' ? WRAPPED_SOL_MINT : mint;
    const toMint = side === 'buy' ? mint : WRAPPED_SOL_MINT;
    const fromAmount = amount; // number | 'auto' | '50%'
    const slippage = slippagePercent;

    // Prepare optional args for getSwapInstructions
    const priorityFeeArg = priorityFee;
    const forceLegacy = false;
    const additionalOptions = {};

    logger.debug(
      chalk.gray(
        `[swapEngine] getSwapInstructions side=${side} from=${fromMint} to=${toMint} amount=${fromAmount} slippage=${slippage}% priorityFee=${priorityFeeArg}`
      )
    );

    let swapResp;
    try {
      swapResp = await tracker.getSwapInstructions(
        fromMint,
        toMint,
        fromAmount,
        slippage,
        walletPubkey,
        priorityFeeArg,
        forceLegacy,
        additionalOptions
      );
    } catch (err) {
      logger.error('[swapEngine] getSwapInstructions failed:', err?.message || err);
      throw err;
    }

    const rate = extractRate(swapResp);
    if (!rate || typeof rate !== 'object') {
      throw new Error('[swapEngine] No rate/quote returned from swap simulation');
    }

    const amountIn = Number(rate.amountIn);
    const amountOut = Number(rate.amountOut);

    if (!Number.isFinite(amountIn) || !Number.isFinite(amountOut)) {
      throw new Error('[swapEngine] Invalid rate from swap simulation: amountIn/amountOut must be finite numbers');
    }

    const priceImpact = Number.isFinite(Number(rate.priceImpact))
      ? Number(rate.priceImpact)
      : undefined;

    const totalFees = Number.isFinite(Number(rate.fee))
      ? Number(rate.fee)
      : undefined;

    const maxPriceImpactEnv = process.env.SC_SWAP_MAX_PRICE_IMPACT;
    const maxPriceImpact = Number.isFinite(Number(maxPriceImpactEnv))
      ? Number(maxPriceImpactEnv)
      : 30; // default 30%

    if (priceImpact !== undefined && priceImpact > maxPriceImpact) {
      const msg = `[swapEngine] Aborting ${side} on ${mint}: priceImpact=${priceImpact}% exceeds max=${maxPriceImpact}%`;
      logger.warn(msg);
      throw new Error(msg);
    }

    // Best-effort token/SOL amounts based on direction
    let tokensReceivedDecimal;
    let solReceivedDecimal;
    if (side === 'buy') {
      // from: SOL, to: token
      solReceivedDecimal = -Math.abs(amountIn);
      tokensReceivedDecimal = amountOut;
    } else {
      // from: token, to: SOL
      tokensReceivedDecimal = -Math.abs(amountIn);
      solReceivedDecimal = amountOut;
    }

    if (dryRun) {
      logger.debug('[swapEngine] dry-run enabled; not broadcasting transaction.');
      return {
        txid: null,
        side,
        tokensReceivedDecimal,
        solReceivedDecimal,
        totalFees,
        priceImpact,
        quote: rate,
        dryRun: true,
      };
    }

    const performOptions = {
      sendOptions: { skipPreflight: true },
      confirmationRetries: 30,
      confirmationRetryTimeout: 500,
      lastValidBlockHeightBuffer: 150,
      resendInterval: 1000,
      confirmationCheckInterval: 1000,
      commitment: 'processed',
      skipConfirmationCheck: false,
    };

    if (useJito) {
      const jitoTipEnv = process.env.SOLANA_SWAP_JITO_TIP;
      if (!jitoTipEnv) {
        throw new Error('Jito trading requested (useJito=true) but SOLANA_SWAP_JITO_TIP is not set.');
      }
      const jitoTip = Number(jitoTipEnv);
      if (!Number.isFinite(jitoTip) || jitoTip <= 0) {
        throw new Error('SOLANA_SWAP_JITO_TIP must be a positive number (SOL units).');
      }
      performOptions.jito = {
        enabled: true,
        tip: jitoTip,
      };
    }

    let txid;
    try {
      const result = await tracker.performSwap(swapResp, performOptions);
      txid = typeof result === 'string' ? result : result?.signature || result?.txid || null;
    } catch (err) {
      logger.error('[swapEngine] performSwap failed:', err?.message || err);
      throw err;
    }

    return {
      txid,
      side,
      tokensReceivedDecimal,
      solReceivedDecimal,
      totalFees,
      priceImpact,
      quote: rate,
    };
  } finally {
    if (hasPendingSwapHelpers) {
      try {
        BootyBox.clearPendingSwap(mint);
      } catch (err) {
        logger.warn(
          '[swapEngine] Failed to clear pending swap flag for mint',
          mint,
          err?.message || err,
        );
      }
    }
  }
}

module.exports = {
  performTrade,
};
