// lib/swap/swapHelper.js
"use strict";

const { SolanaTracker } = require("solana-swap");
const bs58 = require("bs58");
const { Keypair } = require("@solana/web3.js"); // minimal, just like Warlord
const { loadConfig } = require("./swapConfig"); // or wherever Scoundrel stores swap config
const getWalletPrivateKey = require("../wallets/getWalletPrivateKey");
const logger = require("../logger");
const { isStableMint } = require("../solana/stableMints");

// Wrapped SOL mint address on Solana
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

let _clientCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSwapError(err) {
  if (!err || !err.message) return false;
  const msg = err.message;
  const retryPatterns = [
    /Transaction simulation failed/i,
    /Blockhash not found/i,
    /node is behind/i,
    /timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i,
    /429|rate limit/i,
  ];
  return retryPatterns.some((pattern) => pattern.test(msg));
}

/**
 * Build or reuse a SolanaTracker client for a given wallet alias.
 *
 * @param {string} walletAlias
 */
async function getTrackerClient(walletAlias) {
  if (_clientCache.has(walletAlias)) {
    return _clientCache.get(walletAlias);
  }

  const clientPromise = makeTrackerClient(walletAlias).catch((err) => {
    _clientCache.delete(walletAlias);
    throw err;
  });

  _clientCache.set(walletAlias, clientPromise);
  return clientPromise;
}

async function makeTrackerClient(walletAlias) {
  const cfg = await loadConfig(); // your Scoundrel config; you can adapt fields

  const raw = await getWalletPrivateKey(walletAlias);
  if (!raw) {
    throw new Error(`Private key not found for wallet alias "${walletAlias}"`);
  }

  // Decode wallet secret key (JSON array or Base58), same as Warlord.  [oai_citation:2‡trades.js](sediment://file_00000000ffdc71fdbb34a9a82b7917c0)
  let secretBytes;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    secretBytes = Uint8Array.from(JSON.parse(trimmed));
  } else {
    secretBytes = bs58.decode(trimmed);
  }
  const keypair = Keypair.fromSecretKey(secretBytes);

  // TODO: replace with your Scoundrel config fields
  let rpcUrl = cfg.rpcUrl;
  if (!rpcUrl.includes("advancedTx")) {
    const separator = rpcUrl.includes("?") ? "&" : "?";
    rpcUrl = `${rpcUrl}${separator}advancedTx=true`;
  }

  const apiKey = cfg.swapApiKey || undefined;
  const debugEnabled = Boolean(
    cfg.DEBUG_MODE || process.env.NODE_ENV === "development"
  );

  const tracker = new SolanaTracker(keypair, rpcUrl, apiKey, debugEnabled);

  if (debugEnabled && typeof tracker.setDebug === "function") {
    tracker.setDebug(true);
  }

  return tracker;
}

async function getSwapInstructionsWithConfig({
  tracker,
  fromMint,
  toMint,
  amount,
  slippage,
  priorityFeeArg,
  opts,
}) {
  return tracker.getSwapInstructions(
    fromMint,
    toMint,
    amount,
    slippage,
    tracker.keypair.publicKey.toBase58(),
    priorityFeeArg,
    false,
    opts
  );
}

async function performSwapWithRetry({
  tracker,
  buildInstructions,
  debugEnabled,
  context,
  maxAttempts = 3,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const swapResp = await buildInstructions();
      const result = await tracker.performSwap(swapResp, {
        debug: debugEnabled,
      });
      return { result, swapResp };
    } catch (err) {
      const retryable = isRetryableSwapError(err);
      logger.warn(
        `[swap retry] attempt ${attempt}/${maxAttempts} retryable=${retryable} context=${context} error=${
          err.message || err
        }`
      );
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      const baseDelay = 250 * Math.pow(2, attempt - 1);
      const jitterFactor = 0.7 + Math.random() * 0.6; // between 0.7 and 1.3
      const delay = baseDelay * jitterFactor;
      await sleep(delay);
    }
  }
}

async function buyToken({ walletAlias, mint, amount }) {
  const cfg = await loadConfig();
  const tracker = await getTrackerClient(walletAlias);
  const debugEnabled = Boolean(
    cfg.DEBUG_MODE || process.env.NODE_ENV === "development"
  );
  if (debugEnabled) {
    logger.debug(`[trades] buy mint ${mint} stable=${isStableMint(mint)}`);
  }

  const slippage = Number(cfg.slippage ?? 15);
  const priorityFeeArg =
    cfg.priorityFee === undefined ? undefined : cfg.priorityFee;

  const opts = {
    txVersion: cfg.txVersion || "v0",
    priorityFeeLevel: cfg.priorityFeeLevel || "low",
  };

  const buildInstructions = () =>
    getSwapInstructionsWithConfig({
      tracker,
      fromMint: WRAPPED_SOL_MINT,
      toMint: mint,
      amount,
      slippage,
      priorityFeeArg,
      opts,
    });

  const { result, swapResp } = await performSwapWithRetry({
    tracker,
    buildInstructions,
    debugEnabled,
    context: `buy wallet=${walletAlias} mint=${mint}`,
    maxAttempts: 3,
  });

  const txid = result.signature ?? result;

  const quote = swapResp.quote ?? swapResp.rate ?? {};
  const tokensReceivedDecimal = Number(quote.amountOut ?? 0);
  const fee = Number(quote.fee ?? 0);
  const platformFee = Number(quote.platformFeeUI ?? 0);
  const totalFees = fee + platformFee;
  const priceImpact = quote.priceImpact;

  return { txid, tokensReceivedDecimal, totalFees, priceImpact, quote };
}

async function sellToken({ walletAlias, mint, amount }) {
  const cfg = await loadConfig();
  const tracker = await getTrackerClient(walletAlias);
  const debugEnabled = Boolean(
    cfg.DEBUG_MODE || process.env.NODE_ENV === "development"
  );
  if (debugEnabled) {
    logger.debug(`[trades] sell mint ${mint} stable=${isStableMint(mint)}`);
  }

  const slippage = Number(cfg.slippage ?? 15);
  const priorityFeeArg =
    cfg.priorityFee === undefined ? undefined : cfg.priorityFee;

  const opts = {
    txVersion: cfg.txVersion || "v0",
    priorityFeeLevel: cfg.priorityFeeLevel || "low",
  };

  // TODO: optionally bump slippage / priority fee on retry #2+ (only for stop-loss exits).
  const buildInstructions = () =>
    getSwapInstructionsWithConfig({
      tracker,
      fromMint: mint,
      toMint: WRAPPED_SOL_MINT,
      amount,
      slippage,
      priorityFeeArg,
      opts,
    });

  const { result, swapResp } = await performSwapWithRetry({
    tracker,
    buildInstructions,
    debugEnabled,
    context: `sell wallet=${walletAlias} mint=${mint}`,
    maxAttempts: 3,
  });

  const txid = result.signature ?? result;

  const quote = swapResp.quote ?? swapResp.rate ?? {};
  const solReceivedDecimal = Number(quote.outAmount ?? quote.amountOut ?? 0);
  const fee = Number(quote.fee ?? 0);
  const platformFee = Number(quote.platformFeeUI ?? 0);
  const totalFees = fee + platformFee;
  const priceImpact = quote.priceImpact;

  return { txid, solReceivedDecimal, totalFees, priceImpact, quote };
}

module.exports = {
  buyToken,
  sellToken,
};
