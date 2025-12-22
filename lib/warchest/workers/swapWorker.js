'use strict';

const path = require('path');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const { spawn } = require('child_process');

const logger = require('../../logger');
const { loadConfig } = require('../../swap/swapConfig');
const { validateSwapPayload } = require('../../swap/validateSwapPayload');
const { isStableMint } = require('../../solana/stableMints');
const { createWorkerHarness, forkWorkerWithPayload, buildWorkerEnv } = require('./harness');

/**
 * @typedef {Object} SwapWorkerPayload
 * @property {'buy'|'sell'} side
 * @property {string} mint
 * @property {number|string} amount
 * @property {string} [walletAlias]
 * @property {number|string} [walletId]
 * @property {string} [walletPubkey]
 * @property {string} [walletPrivateKey]
 * @property {boolean} [dryRun]
 * @property {boolean} [detachMonitor] - When true, tx confirmation/persistence runs in a detached process.
 */

/**
 * @typedef {Object} SwapWorkerResult
 * @property {string|null} txid
 * @property {string|null} signature
 * @property {number|null} slot
 * @property {{ startedAt:number, endedAt:number, durationMs:number }} timing
 * @property {Object} [quote]
 * @property {number|undefined} [tokensReceivedDecimal]
 * @property {number|undefined} [solReceivedDecimal]
 * @property {number|undefined} [totalFees]
 * @property {number|undefined} [priceImpact]
 * @property {boolean} [dryRun]
 */

function loadTradeExecutor() {
  if (process.env.SWAP_WORKER_EXECUTOR) {
    const modPath = process.env.SWAP_WORKER_EXECUTOR;
    return require(path.isAbsolute(modPath) ? modPath : path.join(process.cwd(), modPath));
  }
  // Lazy require to defer heavy deps until needed.
  // eslint-disable-next-line global-require
  return require('../../swapEngine');
}

let tradeExecutor = null;
let walletKeyResolver = null;
let txMonitorWorkerPath = null;

function buildSwapQuoteContext(payload, result) {
  const rawQuoteResponse =
    result &&
    result.swapResponse &&
    result.swapResponse.rate &&
    result.swapResponse.rate.rawQuoteResponse
      ? result.swapResponse.rate.rawQuoteResponse
      : undefined;
  const quote = result && result.quote ? result.quote : null;
  const inputMint =
    (quote && (quote.inputMint || quote.inMint || quote.baseMint)) ||
    (rawQuoteResponse && rawQuoteResponse.inputMint) ||
    null;
  const outputMint =
    (quote && (quote.outputMint || quote.outMint || quote.quoteMint)) ||
    (rawQuoteResponse && rawQuoteResponse.outputMint) ||
    null;
  return {
    side: payload.side,
    mint: payload.mint,
    inputMint,
    outputMint,
    requestedAmount: payload.amount,
    slippagePercent: payload.slippagePercent,
    priorityFee: payload.priorityFee,
    priorityFeeLevel: payload.priorityFeeLevel || null,
    txVersion: payload.txVersion || null,
    useJito: payload.useJito,
    debugLogging: Boolean(payload.debugLogging),
    showQuoteDetails: Boolean(payload.showQuoteDetails),
    tokensReceivedDecimal: result.tokensReceivedDecimal,
    solReceivedDecimal: result.solReceivedDecimal,
    totalFees: result.totalFees,
    priceImpact: result.priceImpact,
    quote: result.quote,
    rawQuoteResponse,
  };
}

function buildExplorerUrl(txid) {
  const base = process.env.SOLANA_EXPLORER_BASE_URL || 'https://solscan.io/tx';
  return txid ? `${base}/${txid}` : null;
}

function buildTxSummarySeedFromSwapResult(payload, normalized, result, timing) {
  const txid = (result && (result.txid || result.signature)) || null;
  return {
    kind: 'swap',
    status: txid ? 'submitted' : 'failed',
    label: txid ? `${normalized.side} swap submitted` : `${normalized.side} swap failed`,
    side: normalized.side,
    mint: normalized.mint,
    inputMint: (result && result.quote && (result.quote.inputMint || result.quote.inMint || result.quote.baseMint)) || null,
    outputMint: (result && result.quote && (result.quote.outputMint || result.quote.outMint || result.quote.quoteMint)) || null,
    txid,
    explorerUrl: buildExplorerUrl(txid),
    durationMs: timing && typeof timing.durationMs === 'number' ? timing.durationMs : null,
    // swap-derived metrics (already computed by swap engine)
    tokens: result && result.tokensReceivedDecimal !== undefined ? result.tokensReceivedDecimal : undefined,
    sol: result && result.solReceivedDecimal !== undefined ? result.solReceivedDecimal : undefined,
    totalFeesSol: result && result.totalFees !== undefined ? result.totalFees : undefined,
    priceImpactPct: result && result.priceImpact !== undefined ? result.priceImpact : undefined,
    quote: payload && payload.showQuoteDetails ? result.quote : undefined,
    // error details can be filled by txMonitor once confirmation completes
    err: null,
  };
}

function getTradeExecutor() {
  if (!tradeExecutor) {
    tradeExecutor = loadTradeExecutor();
  }
  return tradeExecutor;
}

function getTxMonitorWorkerPath() {
  if (txMonitorWorkerPath) return txMonitorWorkerPath;
  txMonitorWorkerPath = process.env.TX_MONITOR_WORKER_PATH
    ? path.resolve(process.env.TX_MONITOR_WORKER_PATH)
    : path.join(__dirname, 'txMonitorWorker.js');
  return txMonitorWorkerPath;
}

function writeDetachedPayloadFile(txid, payload) {
  const dir = path.join(process.cwd(), 'data', 'warchest', 'tx-monitor-requests');
  fs.mkdirSync(dir, { recursive: true });
  const safeTxid = txid ? String(txid).replace(/[^a-z0-9_-]/gi, '_') : 'unknown';
  const filePath = path.join(dir, `${safeTxid}-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function spawnTxMonitorDetached(context) {
  const workerPath = getTxMonitorWorkerPath();
  const payloadFile = writeDetachedPayloadFile(context && context.txid, context);

  const passthroughEnv = {};
  ['TX_MONITOR_TEST_LOG', 'TX_MONITOR_RPC_FACTORY', 'TX_MONITOR_EVENT_PATH'].forEach((key) => {
    if (process.env[key]) passthroughEnv[key] = process.env[key];
  });
  const env = {
    ...process.env,
    ...buildWorkerEnv({
      rpcEndpoint:
        process.env.WARCHEST_RPC_ENDPOINT ||
        process.env.SOLANATRACKER_RPC_HTTP_URL ||
        process.env.SOLANA_RPC_URL,
      dataEndpoint: process.env.WARCHEST_DATA_ENDPOINT || process.env.SOLANATRACKER_DATA_ENDPOINT,
      extraEnv: passthroughEnv,
    }),
  };

  const child = spawn(process.execPath, [workerPath, '--payload-file', payloadFile], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();

  return { pid: child.pid, payloadFile };
}

async function resolveWalletSecret(walletAlias, providedSecret) {
  if (providedSecret) return providedSecret;
  if (!walletKeyResolver) {
    // eslint-disable-next-line global-require
    walletKeyResolver = require('../../wallets/getWalletPrivateKey');
  }
  return walletKeyResolver(walletAlias);
}

function keypairFromSecret(secret) {
  const trimmed = String(secret || '').trim();
  if (!trimmed) {
    throw new Error('walletPrivateKey is required to build a keypair');
  }

  let secretBytes;
  if (trimmed.startsWith('[')) {
    secretBytes = Uint8Array.from(JSON.parse(trimmed));
  } else {
    secretBytes = bs58.decode(trimmed);
  }

  return Keypair.fromSecretKey(secretBytes);
}

/**
 * Execute a swap request using swapEngine.performTrade.
 *
 * @param {SwapWorkerPayload} payload
 * @returns {Promise<SwapWorkerResult>}
 */
async function executeSwap(payload, tools = {}) {
  const normalized = validateSwapPayload(payload);
  const progress = tools && typeof tools.progress === 'function' ? tools.progress : null;
  if (progress) progress('swap:validated', { mint: normalized.mint, side: normalized.side, detach: normalized.detachMonitor });
  const secret = await resolveWalletSecret(normalized.walletAlias, normalized.walletPrivateKey);
  if (progress) progress('swap:secret:resolved', { walletAlias: normalized.walletAlias || null });
  const keypair = keypairFromSecret(secret);
  const keypairPubkey = keypair && keypair.publicKey ? keypair.publicKey.toBase58() : null;
  if (normalized.walletPubkey && keypairPubkey && normalized.walletPubkey !== keypairPubkey) {
    throw new Error(
      `Resolved wallet pubkey (${normalized.walletPubkey}) does not match private key pubkey (${keypairPubkey}). ` +
        'Check the wallet registry entry and key_ref environment value.'
    );
  }
  const swapConfig = await loadConfig();
  if (swapConfig && swapConfig.rpcUrl) {
    if (!process.env.SOLANATRACKER_RPC_HTTP_URL) {
      process.env.SOLANATRACKER_RPC_HTTP_URL = String(swapConfig.rpcUrl);
    }
    if (!process.env.SOLANA_RPC_URL) {
      process.env.SOLANA_RPC_URL = String(swapConfig.rpcUrl);
    }
  }
  if (swapConfig && swapConfig.swapAPIKey) {
    if (!process.env.SOLANATRACKER_API_KEY) {
      process.env.SOLANATRACKER_API_KEY = String(swapConfig.swapAPIKey);
    }
    if (!process.env.SWAP_API_KEY) {
      process.env.SWAP_API_KEY = String(swapConfig.swapAPIKey);
    }
  }
  const slippageRaw = swapConfig && swapConfig.slippage !== undefined
    ? swapConfig.slippage
    : swapConfig && swapConfig.slippagePercent !== undefined
      ? swapConfig.slippagePercent
      : 15;
  const slippagePercent = Number(slippageRaw);
  if (!Number.isFinite(slippagePercent) || slippagePercent <= 0) {
    throw new Error('swap config slippage must be a positive number');
  }
  const priorityFee = swapConfig ? swapConfig.priorityFee : undefined;
  const priorityFeeLevel = swapConfig ? swapConfig.priorityFeeLevel : undefined;
  const txVersion = swapConfig ? swapConfig.txVersion : undefined;
  const showQuoteDetails = Boolean(swapConfig && swapConfig.showQuoteDetails);
  const debugLogging = Boolean(swapConfig && swapConfig.DEBUG_MODE);
  const useJito = Boolean(swapConfig && swapConfig.useJito);
  const jitoTip = swapConfig && swapConfig.jitoTip !== undefined ? swapConfig.jitoTip : undefined;

  const startedAt = Date.now();
  const { performTrade } = getTradeExecutor();
  const walletPubkey =
    normalized.walletPubkey ||
    keypairPubkey;

  if (progress) progress('swap:engine:start', { walletPubkey });
  const configPayload = {
    ...normalized,
    slippagePercent,
    priorityFee,
    priorityFeeLevel,
    txVersion,
    showQuoteDetails,
    debugLogging,
    useJito,
    jitoTip,
  };
  if (debugLogging) {
    logger.debug(`[swapWorker] mint ${normalized.mint} stable=${isStableMint(normalized.mint)}`);
  }

  const result = await performTrade({
    side: normalized.side,
    mint: normalized.mint,
    amount: normalized.amount,
    walletPubkey,
    keypair,
    slippagePercent,
    priorityFee,
    priorityFeeLevel,
    useJito,
    txVersion,
    showQuoteDetails,
    debugLogging,
    jitoTip,
    dryRun: normalized.dryRun,
    skipConfirmationCheck: true,
  });

  const endedAt = Date.now();
  const signature = result.signature || result.txid || null;
  const slot = Number.isFinite(Number(result.slot)) ? Number(result.slot) : null;
  const timing = {
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
  let monitorResult = null;

  if (!result.dryRun && result.txid) {
    if (progress) progress('swap:submitted', { txid: result.txid });
    const monitorContext = {
      txid: result.txid,
      wallet: walletPubkey || normalized.walletAlias || normalized.walletPrivateKey || null,
      walletAlias: normalized.walletAlias || null,
      walletId: normalized.walletId !== undefined ? normalized.walletId : null,
      mint: normalized.mint,
      side: normalized.side,
      size: normalized.amount,
      slippagePercent: normalized.slippagePercent,
      priorityFeeLevel: normalized.priorityFeeLevel || null,
      txVersion: normalized.txVersion || null,
      showQuoteDetails: normalized.showQuoteDetails,
      debugLogging: normalized.debugLogging,
      swapQuote: buildSwapQuoteContext(configPayload, result),
      txSummarySeed: buildTxSummarySeedFromSwapResult(configPayload, normalized, result, timing),
    };

    if (normalized.detachMonitor) {
      try {
        const detached = spawnTxMonitorDetached(monitorContext);
        monitorResult = {
          status: 'detached',
          detached: true,
          pid: detached.pid,
          payloadFile: detached.payloadFile,
          txSummary: monitorContext.txSummarySeed,
        };
        if (progress) progress('swap:monitor:detached', { pid: detached.pid });
      } catch (err) {
        logger.warn(`[swapWorker] failed to detach tx monitor for ${monitorContext.txid}: ${err?.message || err}`);
        monitorResult = null;
      }
    } else {
      if (progress) progress('swap:monitor:start', {});
      monitorResult = await spawnTxMonitor(monitorContext);
      if (progress) progress('swap:monitor:done', { status: monitorResult && monitorResult.status ? monitorResult.status : null });
    }
  }

  return {
    ...result,
    txid: result.txid || signature,
    signature,
    slot,
    walletPubkey,
    walletAlias: normalized.walletAlias || null,
    walletId: normalized.walletId !== undefined ? normalized.walletId : null,
    timing,
    monitor: monitorResult || null,
  };
}

async function spawnTxMonitor(context) {
  const workerPath = getTxMonitorWorkerPath();
  const passthroughEnv = {};
  ['TX_MONITOR_TEST_LOG', 'TX_MONITOR_RPC_FACTORY', 'TX_MONITOR_EVENT_PATH'].forEach((key) => {
    if (process.env[key]) passthroughEnv[key] = process.env[key];
  });
  const env = buildWorkerEnv({
    rpcEndpoint:
      process.env.WARCHEST_RPC_ENDPOINT ||
      process.env.SOLANATRACKER_RPC_HTTP_URL ||
      process.env.SOLANA_RPC_URL,
    dataEndpoint: process.env.WARCHEST_DATA_ENDPOINT || process.env.SOLANATRACKER_DATA_ENDPOINT,
    extraEnv: passthroughEnv,
  });

  try {
    const { result } = await forkWorkerWithPayload(workerPath, {
      payload: context,
      env,
      timeoutMs: 120_000,
    });
    return result || null;
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[swapWorker] tx monitor failed to start for ${context.txid}: ${msg}`);
  }
  return null;
}

function startHarness() {
  createWorkerHarness(async (payload, tools) => {
    try {
      const result = await executeSwap(payload, tools);
      return result;
    } catch (err) {
      logger.error('[swapWorker] swap failed:', err?.message || err);
      throw err;
    }
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  executeSwap,
};
