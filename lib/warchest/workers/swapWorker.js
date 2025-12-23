'use strict';

const path = require('path');
const bs58 = require('bs58');
const fs = require('fs');
const { spawn } = require('child_process');

const logger = require('../../logger');
const { loadConfig } = require('../../swap/swapConfig');
const { validateSwapPayload } = require('../../swap/validateSwapPayload');
const { isStableMint } = require('../../solana/stableMints');
const { createWorkerHarness, forkWorkerWithPayload, buildWorkerEnv } = require('./harness');
const { createKeyPairFromBytes, createSignerFromKeyPair } = require('@solana/kit');
const { createKeyPairFromPrivateKeyBytes } = require('@solana/keys');

const { executeSwapV3 } = require('../../swap/swapV3');

// Lazily loaded helpers (avoid loading until needed)
let walletKeyResolver = null;
let txMonitorWorkerPath = null;

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

/**
 * Ensure the BootyBox adapter is ready before processing trades.
 *
 * @returns {Promise<object>} Initialized BootyBox adapter.
 * @throws {Error} When BootyBox is unavailable or missing required helpers.
 */
async function ensureBootyBoxReady() {
  let BootyBox = {};

  try {
    // BootyBox index should select the SQLite adapter.
    // If it is not available in this environment, we fall back to a no-op
    // object so WalletManagerV2 can still run without persisting trades.
    // Adjust the require path if your BootyBox entrypoint lives elsewhere.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    BootyBox = require('../../../db');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[swapWorker] BootyBox module not available: ${msg}`);
    throw new Error('BootyBox client unavailable; warchest cannot persist trades.');
  }

  if (!BootyBox || typeof BootyBox.init !== 'function') {
    throw new Error('BootyBox client unavailable; warchest cannot persist trades.');
  }

  try {
    await BootyBox.init();
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[swapWorker] BootyBox init failed: ${msg}`);
    throw new Error('BootyBox init failed.');
  }

  const missing = [];
  // getTokenAmount is a getter we need to handle swap amount percentages
  if (typeof BootyBox.getTokenAmount !== 'function') missing.push('getTokenAmount');

  if (missing.length) {
    logger.error(
      `[swapWorker] BootyBox missing required helpers (${missing.join(', ')}); warchest persistence disabled.`,
    );
    throw new Error('BootyBox missing required helpers.');
  }

  return BootyBox;
}

function isPercentAmount(v) {
  if (typeof v !== 'string') return false;
  return /^\s*\d+(?:\.\d+)?\s*%\s*$/.test(v);
}

function parsePercent(v) {
  const s = String(v || '').trim();
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n;
}

function isAutoAmount(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === 'auto' || s === 'all' || s === 'max' || s === '100%';
}

async function getTokenAmountFromBootyBox(bootyBox, { walletId, walletAlias, mint }) {
  if (!bootyBox || typeof bootyBox.getTokenAmount !== 'function') {
    throw new Error('BootyBox.getTokenAmount is not available');
  }

  // Try object-style first (most robust)
  try {
    return await bootyBox.getTokenAmount({ walletId, walletAlias, mint });
  } catch (e) {
    // fall through
  }

  // Try positional styles (older helper variants)
  const args = [];
  if (walletId !== undefined && walletId !== null && walletId !== '') args.push(walletId);
  if (walletAlias) args.push(walletAlias);
  args.push(mint);

  return await bootyBox.getTokenAmount(...args);
}

async function resolveFromAmountDecimal({ normalized, walletId, walletAlias, bootyBox, progress }) {
  const raw = normalized.amount;

  // BUY amounts are SOL decimals from CLI/config; leave unchanged.
  if (normalized.side === 'buy') {
    return Number(raw);
  }

  // SELL: numeric amount -> use as-is.
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;

  // SELL: percent/auto -> resolve against current position amount via BootyBox.
  if (!isPercentAmount(raw) && !isAutoAmount(raw)) {
    throw new Error(
      `swapV3 sell amount must be numeric or percent/auto (got ${String(raw)}). ` +
        'Examples: -s 50%  |  -s 100%  |  -s auto'
    );
  }

  if (progress) progress('swap:amount:resolve:start', { mode: isAutoAmount(raw) ? 'auto' : 'percent' });

  const positionAmount = await getTokenAmountFromBootyBox(bootyBox, {
    walletId,
    walletAlias,
    mint: normalized.mint,
  });

  const posNum = Number(positionAmount);
  if (!Number.isFinite(posNum) || posNum <= 0) {
    throw new Error(
      `No open position amount available to size sell for mint ${normalized.mint} (got ${String(positionAmount)}).`
    );
  }

  if (isAutoAmount(raw)) {
    if (progress) progress('swap:amount:resolve:done', { resolved: posNum, positionAmount: posNum });
    return posNum;
  }

  const pct = parsePercent(raw);
  if (pct == null || pct <= 0) {
    throw new Error(`Invalid percent sell amount: ${String(raw)}`);
  }

  const resolved = (posNum * pct) / 100;
  if (progress) progress('swap:amount:resolve:done', { resolved, positionAmount: posNum, pct });
  return resolved;
}

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

async function keypairFromSecret(secret) {
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

  // Many Solana exports are 64 bytes (private+public). Some are 32-byte seeds/private.
  if (secretBytes.length === 64) {
    return createKeyPairFromBytes(secretBytes);
  }
  if (secretBytes.length === 32) {
    return createKeyPairFromPrivateKeyBytes(secretBytes);
  }

  throw new Error(`Unsupported secret key length ${secretBytes.length}; expected 32 or 64 bytes`);
}

/**
 * Execute a swap request using swapV3.executeSwapV3.
 *
 * @param {SwapWorkerPayload} payload
 * @param {Object} [tools]
 * @returns {Promise<SwapWorkerResult>}
 */
async function executeSwap(payload, tools = {}) {
  const normalized = validateSwapPayload(payload);
  const progress = tools && typeof tools.progress === 'function' ? tools.progress : null;
  if (progress) progress('swap:validated', { mint: normalized.mint, side: normalized.side, detach: normalized.detachMonitor });
  const secret = await resolveWalletSecret(normalized.walletAlias, normalized.walletPrivateKey);
  if (progress) progress('swap:secret:resolved', { walletAlias: normalized.walletAlias || null });
  const keypair = await keypairFromSecret(secret);
  const signer = await createSignerFromKeyPair(keypair);
  const keypairPubkey = signer && signer.address ? String(signer.address) : null;
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

  const walletPubkey =
    normalized.walletPubkey ||
    keypairPubkey;

  if (progress) progress('swap:engine:start', { walletPubkey });

  // Build mint routing
  const WSOL = process.env.SOLANA_WSOL_MINT || 'So11111111111111111111111111111111111111112';
  const fromMint = normalized.side === 'buy' ? WSOL : normalized.mint;
  const toMint = normalized.side === 'buy' ? normalized.mint : WSOL;

  // Resolve amount.
  // - BUY: numeric SOL amount
  // - SELL: numeric token amount OR percent/auto sized from current position via BootyBox
  let bootyBox = null;
  if (normalized.side === 'sell' && (isPercentAmount(normalized.amount) || isAutoAmount(normalized.amount))) {
    bootyBox = await ensureBootyBoxReady();
  }

  const fromAmountNum = await resolveFromAmountDecimal({
    normalized,
    walletId: normalized.walletId,
    walletAlias: normalized.walletAlias,
    bootyBox,
    progress,
  });

  if (!Number.isFinite(fromAmountNum) || fromAmountNum <= 0) {
    throw new Error(`swapV3: resolved fromAmount must be > 0 (got ${String(fromAmountNum)})`);
  }

  // Create RPC client via existing factory (SolanaTracker RPC).
  // Lazy-require to avoid loading kit RPC until needed.
  // eslint-disable-next-line global-require
  const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
  // eslint-disable-next-line global-require
  const { createRpcMethods } = require('../../solana/rpcMethods');

  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
  const rpcMethods = createRpcMethods(rpc, rpcSubs);

  const preflight = String(process.env.SWAP_PREFLIGHT || '').toLowerCase() === 'true';

  let swapV3Resp;
  try {
    swapV3Resp = await executeSwapV3({
      side: normalized.side,
      fromMint,
      toMint,
      fromAmount: fromAmountNum,
      payerAddress: walletPubkey,
      rpc: rpcMethods,
      keyPairs: [keypair],
      swapApiBaseUrl:
        process.env.SOLANATRACKER_SWAP_API_URL ||
        process.env.SWAP_API_URL ||
        (swapConfig && (swapConfig.swapApiUrl || swapConfig.swapApiBaseUrl)) ||
        'https://swap-v2.solanatracker.io/swap',
      swapApiKey:
        process.env.SOLANATRACKER_API_KEY ||
        process.env.SWAP_API_KEY ||
        process.env.SOLANATRACKER_SWAP_API_KEY ||
        (swapConfig && (swapConfig.swapAPIKey || swapConfig.swapApiKey)) ||
        '',
      slippagePercent,
      priorityFeeLevel: priorityFeeLevel || null,
      txVersion: txVersion || null,
      preflight,
      dryRun: Boolean(normalized.dryRun),
    });
  } finally {
    try {
      if (typeof close === 'function') close();
    } catch (e) {
      // ignore
    }
  }

  // Adapt swapV3 response to the legacy shape swapWorker expects.
  const result = {
    txid: swapV3Resp.txid || null,
    signature: swapV3Resp.txid || null,
    dryRun: Boolean(swapV3Resp.dryRun),
    quote: swapV3Resp.rate || null,
    priceImpact: swapV3Resp.priceImpactPercent != null ? swapV3Resp.priceImpactPercent : undefined,
    swapResponse: { rate: swapV3Resp.rate || null },
  };

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
      slippagePercent: slippagePercent,
      priorityFeeLevel: priorityFeeLevel || null,
      txVersion: txVersion || null,
      showQuoteDetails,
      debugLogging,
      swapQuote: buildSwapQuoteContext(normalized, result),
      txSummarySeed: buildTxSummarySeedFromSwapResult(normalized, normalized, result, timing),
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
