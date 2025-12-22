const { SolanaTracker } = require('solana-swap');
const chalk = require('chalk');
const logger = require('./logger');
const { ensureTokenInfo } = require('./services/tokenInfoService');
const { createSolanaTrackerDataClient } = require('./solanaTrackerDataClient');
const { createSolanaTrackerRPCClient } = require('./solanaTrackerRPCClient');
const { createRpcMethods } = require('./solana/rpcMethods');
const { isStableMint } = require('./solana/stableMints');

let BootyBox;
try {
  // Adjust the path to BootyBox if needed in this project.
  BootyBox = require('../db');
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

let tokenInfoDataClient = null;
let swapRpcMethods = null;

function getTokenInfoDataClient() {
  if (tokenInfoDataClient) return tokenInfoDataClient;
  try {
    tokenInfoDataClient = createSolanaTrackerDataClient();
  } catch (err) {
    logger.warn(
      '[swapEngine] Failed to initialize SolanaTracker Data client for token metadata:',
      err?.message || err,
    );
    tokenInfoDataClient = null;
  }
  return tokenInfoDataClient;
}

function getSwapRpcMethods() {
  if (swapRpcMethods) return swapRpcMethods;
  const { rpc, rpcSubs } = createSolanaTrackerRPCClient();
  swapRpcMethods = createRpcMethods(rpc, rpcSubs);
  return swapRpcMethods;
}

/**
 * @typedef {Object} TradeRequest
 * @property {'buy'|'sell'} side
 * @property {string} mint                  // SPL mint to buy/sell
 * @property {number|string} amount         // number, 'auto', or '<percent>%'
 * @property {string} walletPubkey          // base58 public key
 * @property {import('@solana/web3.js').Keypair} keypair
 * @property {number} slippagePercent       // integer percent (e.g. 15)
 * @property {number|string} [priorityFee]  // number in SOL units or 'auto'
 * @property {string} [priorityFeeLevel]
 * @property {boolean} [useJito]
 * @property {number|string} [jitoTip]
 * @property {'v0'|'legacy'} [txVersion]
 * @property {boolean} [dryRun]
 * @property {boolean} [showQuoteDetails]
 * @property {boolean} [debugLogging]
 * @property {boolean} [skipConfirmationCheck] // When true, return txid immediately (txMonitor should confirm/persist)
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
function createSwapClient(keypair, options = {}) {
  const rpcUrl = process.env.SOLANATRACKER_RPC_HTTP_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error('SOLANATRACKER_RPC_HTTP_URL (or SOLANA_RPC_URL) must be set for swap engine.');
  }

  const apiKey = process.env.SOLANATRACKER_API_KEY || process.env.SWAP_API_KEY;
  const debugLogging = Boolean(options.debugLogging);

  logger.debug(
    chalk.gray(
      `[swapEngine] Using RPC URL ${rpcUrl} with API key ${apiKey ? 'present' : 'absent'}`
    )
  );

  const tracker = new SolanaTracker(keypair, rpcUrl, apiKey, debugLogging);
  if (debugLogging && typeof tracker.setDebug === 'function') {
    tracker.setDebug(true);
  }
  return tracker;
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

function redactRpcUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(String(value));
    if (url.searchParams.has('api_key')) {
      url.searchParams.set('api_key', '[REDACTED]');
    }
    return url.toString();
  } catch (_) {
    return String(value);
  }
}

/**
 * Detect confirmation-timeout errors from solana-swap that should be
 * deferred to the txMonitor path when skipConfirmationCheck is enabled.
 *
 * @param {Object} error
 * @returns {boolean}
 */
function isConfirmationFailure(error) {
  if (!error) return false;
  if (error.type && String(error.type) !== 'Unknown') return false;
  const message = String(error.message || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('failed to confirm') ||
    message.includes('confirmation timeout') ||
    message.includes('failed to parse transaction error')
  );
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
    jitoTip,
    priorityFeeLevel,
    txVersion,
    dryRun,
    showQuoteDetails,
    debugLogging,
    skipConfirmationCheck,
  } = request || {};
  const isDev = (process.env.NODE_ENV || '').toLowerCase() === 'development';
  const effectiveDebugLogging = Boolean(debugLogging) || isDev;

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

  const pendingWalletKey = walletPubkey || (keypair && keypair.publicKey && keypair.publicKey.toBase58());

  if (hasPendingSwapHelpers && BootyBox.isSwapPending(mint, pendingWalletKey)) {
    throw new Error(`Swap already pending for mint ${mint}`);
  }

  if (hasPendingSwapHelpers) {
    BootyBox.markPendingSwap(mint, pendingWalletKey);
    logger.debug('[swapEngine] Marked pending swap for mint', mint);
  }

  const shortWallet =
    walletPubkey && walletPubkey.length > 8
      ? `${walletPubkey.slice(0, 4)}...${walletPubkey.slice(-4)}`
      : walletPubkey || 'unknown';
  const formatDisplayAmount = (val) =>
    typeof val === 'number'
      ? Number(val).toLocaleString(undefined, { maximumFractionDigits: 6 })
      : String(val);

  try {
    logger.debug(
      chalk.gray(
        `[swapEngine] swap config txVersion=${txVersion || 'default'} priorityFeeLevel=${priorityFeeLevel || 'default'} debug=${effectiveDebugLogging ? 'on' : 'off'} showQuote=${showQuoteDetails ? 'on' : 'off'}`,
      ),
    );
    // Best-effort metadata warmup: make sure we have token info cached locally.
    // The tokenInfoService is responsible for talking to the Data API and
    // BootyBox; failures here should never block a swap.
    try {
      const tokenMetaClient = getTokenInfoDataClient();
      if (tokenMetaClient && typeof tokenMetaClient.getTokenInformation === 'function') {
        await ensureTokenInfo({ mint, client: tokenMetaClient });
      } else {
        logger.debug('[swapEngine] token info client unavailable; skipping ensureTokenInfo');
      }
    } catch (err) {
      logger.warn(
        '[swapEngine] ensureTokenInfo failed before trade; proceeding without cached metadata:',
        err?.message || err,
      );
    }

    logger.debug(
      `[swapEngine] Preparing ${side.toUpperCase()} on ${mint} | amount=${formatDisplayAmount(amount)} | wallet=${shortWallet}`
    );
    if (effectiveDebugLogging) {
      logger.debug(`[swapEngine] mint ${mint} stable=${isStableMint(mint)}`);
    }

    const tracker = createSwapClient(keypair, { debugLogging: effectiveDebugLogging });
    try {
      const sendEndpoint = process.env.SOLANA_SWAP_CUSTOM_SEND_ENDPOINT || null;
      if (isDev) {
        logger.debug(
          `[swapEngine] custom send endpoint ${sendEndpoint ? 'set' : 'not set'}: ${redactRpcUrl(sendEndpoint)}`,
        );
      }
      if (sendEndpoint && typeof tracker.setCustomSendTransactionEndpoint === 'function') {
        await tracker.setCustomSendTransactionEndpoint(String(sendEndpoint));
      }
    } catch (err) {
      logger.debug(
        `[swapEngine] setCustomSendTransactionEndpoint failed; continuing with default sender: ${err?.message || String(err)}`,
      );
    }

    const fromMint = side === 'buy' ? WRAPPED_SOL_MINT : mint;
    const toMint = side === 'buy' ? mint : WRAPPED_SOL_MINT;
    const fromAmount = amount; // number | 'auto' | '50%'
    const slippage = slippagePercent;

    // Prepare optional args for getSwapInstructions
    const priorityFeeArg = priorityFee;
    const forceLegacy = txVersion === 'legacy';
    const additionalOptions = {};
    if (priorityFeeLevel) {
      additionalOptions.priorityFeeLevel = priorityFeeLevel;
    }
    if (txVersion) {
      additionalOptions.txVersion = txVersion;
    }

    logger.debug(
      chalk.gray(
        `[swapEngine] getSwapInstructions side=${side} from=${fromMint} to=${toMint} amount=${fromAmount} slippage=${slippage}% priorityFee=${priorityFeeArg} priorityFeeLevel=${priorityFeeLevel || 'default'} txVersion=${txVersion || 'v0'}`
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

    const shouldLogQuoteDetails = Boolean(showQuoteDetails) || Boolean(debugLogging) || isDev;
    if (shouldLogQuoteDetails) {
      logger.debug(
        `[swapEngine] Full swap response: ${JSON.stringify(swapResp, null, 2)}`
      );
    } else if (isDev && swapResp && typeof swapResp === 'object') {
      let txnBytes = null;
      try {
        txnBytes = swapResp.txn ? Buffer.from(swapResp.txn, 'base64').length : null;
      } catch (_) {
        txnBytes = null;
      }
      logger.debug('[swapEngine] swap response summary:', {
        type: swapResp.type || null,
        hasTxn: Boolean(swapResp.txn),
        txnBytes,
        hasRate: Boolean(swapResp.rate),
      });
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
    const quoteSummary =
      side === 'buy'
        ? `${formatDisplayAmount(amountIn)} SOL → ${formatDisplayAmount(amountOut)} tokens`
        : `${formatDisplayAmount(amountIn)} tokens → ${formatDisplayAmount(amountOut)} SOL`;
    const priceSolPerToken =
      Number.isFinite(Number(rate.priceImpact)) && Number.isFinite(amountOut) && amountOut !== 0
        ? Math.abs(amountIn / amountOut)
        : Number(rate.executionPrice || rate.currentPrice || null);
    const formattedPrice =
      priceSolPerToken && Number.isFinite(Number(priceSolPerToken))
        ? Number(priceSolPerToken).toLocaleString(undefined, { maximumFractionDigits: 9 })
        : 'n/a';
    logger.debug(
      `[swapEngine] Quote ready: ${quoteSummary} | price=${formattedPrice} SOL/token | impact=${
        priceImpact != null ? `${priceImpact}%` : 'n/a'
      }`
    );

    const maxPriceImpactEnv = process.env.SC_SWAP_MAX_PRICE_IMPACT;
    const maxPriceImpact = Number.isFinite(Number(maxPriceImpactEnv))
      ? Number(maxPriceImpactEnv)
      : 30; // default 30%

    if (priceImpact !== undefined && priceImpact > maxPriceImpact) {
      const msg = `[swapEngine] Aborting ${side} on ${mint}: priceImpact=${priceImpact}% exceeds max=${maxPriceImpact}%`;
      logger.warn(chalk.bgRed(msg));
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
        swapResponse: swapResp,
        dryRun: true,
      };
    }

    // Default to returning the txid immediately. Scoundrel confirms + persists via txMonitor.
    const shouldSkipConfirmationCheck =
      skipConfirmationCheck !== undefined
        ? Boolean(skipConfirmationCheck)
        : process.env.SC_SWAP_SKIP_CONFIRMATION !== '0';

    const performOptions = {
      sendOptions: { skipPreflight: true },
      confirmationRetries: 30,
      confirmationRetryTimeout: 500,
      lastValidBlockHeightBuffer: 150,
      resendInterval: 1000,
      confirmationCheckInterval: 1000,
      commitment: 'confirmed',
      skipConfirmationCheck: shouldSkipConfirmationCheck,
      useWebSocket: !shouldSkipConfirmationCheck,
    };
    if (isDev) {
      logger.debug('[swapEngine] performSwapWithDetails options:', performOptions);
    }

    if (useJito) {
      const jitoTipValue = jitoTip !== undefined && jitoTip !== null
        ? jitoTip
        : process.env.SOLANA_SWAP_JITO_TIP;
      if (jitoTipValue === undefined || jitoTipValue === null || jitoTipValue === '') {
        throw new Error('Jito trading requested (useJito=true) but no Jito tip is configured.');
      }
      const jitoTipNum = Number(jitoTipValue);
      if (!Number.isFinite(jitoTipNum) || jitoTipNum <= 0) {
        throw new Error('Jito tip must be a positive number (SOL units).');
      }
      performOptions.jito = {
        enabled: true,
        tip: jitoTipNum,
      };
    }

    let txid;
    try {
      const result = await tracker.performSwapWithDetails(swapResp, performOptions);
      logger.debug(`[swapEngine] performSwapWithDetails result: ${JSON.stringify(result, null, 2)}`);
      txid = result.signature || result.txid || (typeof result === 'string' ? result : null);

      if (result.error) {
        const signature = result.signature || result.txid || null;
        logger.error('[swapEngine] performSwapWithDetails error:', {
          signature,
          type: result.error.type,
          message: result.error.message,
          programId: result.error.programId,
          instructionIndex: result.error.instructionIndex,
        });
        if (isDev && result.error.rawError) {
          logger.debug('[swapEngine] raw swap error:', result.error.rawError);
        }
        const diagnostics = await getSwapRpcMethods().fetchSignatureDiagnostics(signature);
        if (diagnostics) {
          logger.debug('[swapEngine] swap error diagnostics:', diagnostics);
        }
        txid = result.signature || txid;
        const canBypassConfirmation =
          shouldSkipConfirmationCheck &&
          Boolean(txid) &&
          isConfirmationFailure(result.error);
        if (canBypassConfirmation) {
          logger.warn(
            '[swapEngine] swap confirmation unavailable; treating as submitted and deferring to txMonitor.'
          );
          return {
            txid,
            side,
            tokensReceivedDecimal,
            solReceivedDecimal,
            totalFees,
            priceImpact,
            quote: rate,
            swapResponse: swapResp,
            confirmationPending: true,
            swapError: result.error,
          };
        }
        throw new Error(`Swap failed with error: ${result.error.message} (type: ${result.error.type})`);
      }

      if (!txid) {
        throw new Error('Swap succeeded but no transaction signature was returned.');
      }

      const summaryParts = [
        `txid=${txid}`,
        `side=${side}`,
        tokensReceivedDecimal !== undefined ? `tokens=${tokensReceivedDecimal}` : null,
        solReceivedDecimal !== undefined ? `sol=${solReceivedDecimal}` : null,
        totalFees !== undefined ? `fees=${totalFees}` : null,
        priceImpact !== undefined ? `priceImpact=${priceImpact}%` : null,
      ].filter(Boolean);
      logger.info(`[swapEngine] 💰 Swap submitted: ${summaryParts.join(' | ')}`);
    } catch (err) {
      logger.error('[swapEngine] performSwapWithDetails failed:', err?.message || err);
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
      swapResponse: swapResp,
    };
  } finally {
    if (hasPendingSwapHelpers) {
      try {
        BootyBox.clearPendingSwap(mint, pendingWalletKey);
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
