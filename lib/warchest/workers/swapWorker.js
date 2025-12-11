'use strict';

const path = require('path');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

const logger = require('../../logger');
const { createWorkerHarness, forkWorkerWithPayload, buildWorkerEnv } = require('./harness');

const VALID_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @typedef {Object} SwapWorkerPayload
 * @property {'buy'|'sell'} side
 * @property {string} mint
 * @property {number|string} amount
 * @property {string} [walletAlias]
 * @property {number|string} [walletId]
 * @property {string} [walletPubkey]
 * @property {string} [walletPrivateKey]
 * @property {number} [slippagePercent]
 * @property {number|string} [priorityFee]
 * @property {string} [priorityFeeLevel]
 * @property {boolean} [useJito]
 * @property {'v0'|'legacy'} [txVersion]
  * @property {boolean} [dryRun]
 * @property {boolean} [showQuoteDetails]
 * @property {boolean} [debugLogging]
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
  return {
    side: payload.side,
    mint: payload.mint,
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

async function resolveWalletSecret(walletAlias, providedSecret) {
  if (providedSecret) return providedSecret;
  if (!walletKeyResolver) {
    // eslint-disable-next-line global-require
    walletKeyResolver = require('../../wallets/getWalletPrivateKey');
  }
  return walletKeyResolver(walletAlias);
}

function normalizeAmount(side, raw) {
  if (raw === undefined || raw === null) {
    throw new Error(`Missing amount for ${side} side`);
  }

  const trimmed = raw.toString().trim().toLowerCase().replace(/\s+/g, '');
  if (!trimmed) {
    throw new Error('Amount cannot be empty');
  }

  if (trimmed === 'auto') {
    if (side === 'buy') {
      throw new Error("'auto' is only valid for sells (swap entire balance)");
    }
    return 'auto';
  }

  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed.slice(0, -1));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error('Percentage amount must be between 0 and 100');
    }
    return `${pct}%`;
  }

  const num = parseFloat(trimmed);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Amount must be a positive number');
  }

  return num;
}

function normalizePriorityFee(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === 'auto') return 'auto';

  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error('priorityFee must be a non-negative number or "auto"');
  }
  return num;
}

const PRIORITY_FEE_LEVELS = new Set(['min', 'low', 'medium', 'high', 'veryHigh', 'unsafeMax']);

function normalizePriorityFeeLevel(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const canonical =
    lower === 'veryhigh'
      ? 'veryHigh'
      : lower === 'unsafe' || lower === 'unsafe-max' || lower === 'unsafemax'
        ? 'unsafeMax'
        : trimmed;
  if (!PRIORITY_FEE_LEVELS.has(canonical)) {
    throw new Error('priorityFeeLevel must be one of min, low, medium, high, veryHigh, unsafeMax');
  }
  return canonical;
}

function normalizeTxVersionConfig(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'legacy') return 'legacy';
  if (trimmed === 'v0' || trimmed === '0' || trimmed === 'versioned') return 'v0';
  throw new Error('txVersion must be "v0" or "legacy" when provided');
}

function normalizeMint(mint) {
  const trimmed = String(mint || '').trim();
  if (!VALID_MINT_RE.test(trimmed)) {
    throw new Error(`Invalid mint address: ${trimmed}`);
  }
  return trimmed;
}

function normalizeSlippage(slippagePercent) {
  if (slippagePercent === undefined || slippagePercent === null) return 15;
  const num = Number(slippagePercent);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('slippagePercent must be a positive number');
  }
  return num;
}

/**
 * Validate and normalize a swap payload.
 *
 * @param {SwapWorkerPayload} payload
 * @returns {Required<SwapWorkerPayload>}
 */
function validateSwapPayload(payload) {
  const side = payload && payload.side;
  if (side !== 'buy' && side !== 'sell') {
    throw new Error("Payload.side must be 'buy' or 'sell'");
  }

  const mint = normalizeMint(payload.mint);
  const amount = normalizeAmount(side, payload.amount);
  const slippagePercent = normalizeSlippage(payload.slippagePercent);
  const priorityFee = normalizePriorityFee(payload.priorityFee);
  const priorityFeeLevel = normalizePriorityFeeLevel(payload.priorityFeeLevel);
  const useJito = Boolean(payload.useJito);
  const dryRun = Boolean(payload.dryRun);
  const txVersion = normalizeTxVersionConfig(payload.txVersion);
  const showQuoteDetails = Boolean(payload.showQuoteDetails);
  const debugLogging = Boolean(payload.debugLogging);

  const walletAlias = payload.walletAlias ? String(payload.walletAlias).trim() : undefined;
  const walletId =
    payload.walletId !== undefined && payload.walletId !== null
      ? payload.walletId
      : undefined;
  const walletPubkey = payload.walletPubkey ? String(payload.walletPubkey).trim() : undefined;
  const walletPrivateKey = payload.walletPrivateKey ? String(payload.walletPrivateKey).trim() : undefined;

  if (!walletAlias && !walletPrivateKey) {
    throw new Error('Payload must include walletAlias or walletPrivateKey');
  }

  return {
    side,
    mint,
    amount,
    walletAlias,
    walletId,
    walletPubkey,
    walletPrivateKey,
    slippagePercent,
    priorityFee,
    priorityFeeLevel,
    useJito,
    txVersion,
    showQuoteDetails,
    debugLogging,
    dryRun,
  };
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
async function executeSwap(payload) {
  const normalized = validateSwapPayload(payload);
  const secret = await resolveWalletSecret(normalized.walletAlias, normalized.walletPrivateKey);
  const keypair = keypairFromSecret(secret);
  const startedAt = Date.now();
  const { performTrade } = getTradeExecutor();
  const walletPubkey =
    normalized.walletPubkey ||
    (keypair && keypair.publicKey && keypair.publicKey.toBase58());

  const result = await performTrade({
    side: normalized.side,
    mint: normalized.mint,
    amount: normalized.amount,
    walletPubkey,
    keypair,
    slippagePercent: normalized.slippagePercent,
    priorityFee: normalized.priorityFee,
    priorityFeeLevel: normalized.priorityFeeLevel,
    useJito: normalized.useJito,
    txVersion: normalized.txVersion,
    showQuoteDetails: normalized.showQuoteDetails,
    debugLogging: normalized.debugLogging,
    dryRun: normalized.dryRun,
  });

  const endedAt = Date.now();
  const signature = result.signature || result.txid || null;
  const slot = Number.isFinite(Number(result.slot)) ? Number(result.slot) : null;
  let monitorResult = null;

  if (!result.dryRun && result.txid) {
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
      swapQuote: buildSwapQuoteContext(normalized, result),
    };
    monitorResult = await spawnTxMonitor(monitorContext);
  }

  return {
    ...result,
    txid: result.txid || signature,
    signature,
    slot,
    walletPubkey,
    walletAlias: normalized.walletAlias || null,
    walletId: normalized.walletId !== undefined ? normalized.walletId : null,
    timing: {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
    },
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
  createWorkerHarness(async (payload) => {
    try {
      const result = await executeSwap(payload);
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
  validateSwapPayload,
};
