// lib/trades.js
'use strict';

const { SolanaTracker } = require('solana-swap');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js'); // minimal, just like Warlord
const { loadConfig } = require('../config');     // or wherever Scoundrel stores swap config
const getWalletPrivateKey = require('../lib/wallets/getWalletPrivateKey');

// Wrapped SOL mint address on Solana
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

let _clientCache = new Map();

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
  if (trimmed.startsWith('[')) {
    secretBytes = Uint8Array.from(JSON.parse(trimmed));
  } else {
    secretBytes = bs58.decode(trimmed);
  }
  const keypair = Keypair.fromSecretKey(secretBytes);

  // TODO: replace with your Scoundrel config fields
  let rpcUrl = cfg.rpcUrl;
  if (!rpcUrl.includes('advancedTx')) {
    const separator = rpcUrl.includes('?') ? '&' : '?';
    rpcUrl = `${rpcUrl}${separator}advancedTx=true`;
  }

  const apiKey = cfg.swapAPIKey || undefined;
  const debugEnabled = Boolean(cfg.DEBUG_MODE || process.env.NODE_ENV === 'development');

  const tracker = new SolanaTracker(keypair, rpcUrl, apiKey, debugEnabled);

  if (debugEnabled && typeof tracker.setDebug === 'function') {
    tracker.setDebug(true);
  }

  return tracker;
}

async function buyToken({ walletAlias, mint, amount, slippagePercent, priorityFee }) {
  const cfg = await loadConfig();
  const tracker = await getTrackerClient(walletAlias);
  const debugEnabled = Boolean(cfg.DEBUG_MODE || process.env.NODE_ENV === 'development');

  const slippage = Number(slippagePercent ?? cfg.slippage ?? 15);
  const priorityFeeArg = priorityFee === 'auto'
    ? 'auto'
    : Number(priorityFee ?? cfg.priorityFee ?? 0);

  const opts = {
    txVersion: cfg.txVersion || 'v0',
    priorityFeeLevel: cfg.priorityFeeLevel || 'low',
  };

  const swapResp = await tracker.getSwapInstructions(
    WRAPPED_SOL_MINT,
    mint,
    amount,
    slippage,
    tracker.keypair.publicKey.toBase58(),
    priorityFeeArg,
    false,
    opts
  );

  let txid;
  try {
    const result = await tracker.performSwap(swapResp, { debug: debugEnabled });
    txid = result.signature ?? result;
  } catch (err) {
    throw new Error(`Swap failed: ${err.message || err}`);
  }

  const quote = swapResp.quote ?? swapResp.rate ?? {};
  const tokensReceivedDecimal = Number(quote.amountOut ?? 0);
  const fee = Number(quote.fee ?? 0);
  const platformFee = Number(quote.platformFeeUI ?? 0);
  const totalFees = fee + platformFee;
  const priceImpact = quote.priceImpact;

  return { txid, tokensReceivedDecimal, totalFees, priceImpact, quote };
}

async function sellToken({ walletAlias, mint, amount, slippagePercent, priorityFee }) {
  const cfg = await loadConfig();
  const tracker = await getTrackerClient(walletAlias);
  const debugEnabled = Boolean(cfg.DEBUG_MODE || process.env.NODE_ENV === 'development');

  const slippage = Number(slippagePercent ?? cfg.slippage ?? 15);
  const priorityFeeArg = priorityFee === 'auto'
    ? 'auto'
    : Number(priorityFee ?? cfg.priorityFee ?? 0);

  const opts = {
    txVersion: cfg.txVersion || 'v0',
    priorityFeeLevel: cfg.priorityFeeLevel || 'low',
  };

  const swapResp = await tracker.getSwapInstructions(
    mint,
    WRAPPED_SOL_MINT,
    amount,
    slippage,
    tracker.keypair.publicKey.toBase58(),
    priorityFeeArg,
    false,
    opts
  );

  let txid;
  try {
    const result = await tracker.performSwap(swapResp, { debug: debugEnabled });
    txid = result.signature ?? result;
  } catch (err) {
    throw new Error(`Swap failed: ${err.message || err}`);
  }

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