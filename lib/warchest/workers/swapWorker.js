'use strict';

const path = require('path');
const bs58 = require('bs58');

const baseLogger = require('../../logger');
const { createWorkerLogger } = require('./workerLogger');
const logger = createWorkerLogger({
  workerName: 'swapWorker',
  scope: 'swap',
  baseLogger,
  includeCallsite: true,
  disableFileTransport: true,
});
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const { loadConfig } = require('../../swap/swapConfig');
const { validateSwapPayload } = require('../../swap/validateSwapPayload');
const { isStableMint } = require('../../solana/stableMints');
const { createWorkerHarness } = require('./harness');
const { createKeyPairFromBytes, createSignerFromKeyPair } = require('@solana/kit');
const { createKeyPairFromPrivateKeyBytes } = require('@solana/keys');
const { classifySolanaError } = require('../../solana/errors');

const { executeSwapV3 } = require('../../swap/swapV3');
const { executeSwapRaptor } = require('../../swap/swapRaptor');

// Lazily loaded helpers (avoid loading until needed)
let walletKeyResolver = null;
let swapExecutor = null;

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
 * @property {Object|null} [monitorPayload]
 * @property {boolean} [monitorDetach]
 */

/**
 * Ensure the BootyBox adapter is ready before processing trades.
 *
 * @returns {Promise<object>} Initialized BootyBox adapter.
 * @throws {Error} When BootyBox is unavailable or missing required helpers.
 */
async function ensureBootyBoxReady({ inkMode } = {}) {
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
    (inkMode ? logger.debug : logger.warn)(`[swapWorker] BootyBox module not available: ${msg}`);
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
  // Percent/auto sell sizing requires an unambiguous way to fetch the open position amount.
  // swapWorker operates on the CLI surface (walletAlias + mint), so prefer the alias-based helper.
  const hasTokenAmtByAlias = typeof BootyBox.getTokenAmtByAlias === 'function';
  const hasTokenAmountByMintOnly = typeof BootyBox.getTokenAmount === 'function';

  if (!hasTokenAmtByAlias && !hasTokenAmountByMintOnly) {
    missing.push('getTokenAmtByAlias OR getTokenAmount');
  }

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

async function getTokenAmountFromBootyBox(bootyBox, { walletAlias, mint }) {
  if (!bootyBox) {
    throw new Error('BootyBox is not available');
  }
  if (!walletAlias) {
    throw new Error('Percent/auto sell sizing requires walletAlias');
  }

  // 1) Preferred: alias + mint lookup (single query, deterministic)
  if (typeof bootyBox.getTokenAmtByAlias === 'function') {
    const amt = await bootyBox.getTokenAmtByAlias({ walletAlias, mint });
    return amt;
  }

  // 2) Fallback: legacy mint-only lookup (less safe in multi-wallet setups)
  if (typeof bootyBox.getTokenAmount === 'function') {
    return bootyBox.getTokenAmount(mint);
  }

  throw new Error('Unable to resolve open position amount from BootyBox');
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
      `swapWorker sell amount must be numeric or percent/auto (got ${String(raw)}). ` +
        'Examples: -s 50%  |  -s 100%  |  -s auto'
    );
  }

  if (progress) progress('swap:amount:resolve:start', { mode: isAutoAmount(raw) ? 'auto' : 'percent' });

  const positionAmount = await getTokenAmountFromBootyBox(bootyBox, {
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

function buildExplorerUrl(txid, explorerBaseUrl) {
  const base = explorerBaseUrl || 'https://solscan.io/tx';
  return txid ? `${base}/${txid}` : null;
}

function normalizeTxid(txid) {
  if (!txid) return null;
  if (typeof txid === 'string') return txid;
  if (typeof txid === 'number') return String(txid);
  if (typeof txid === 'object') {
    // Common shapes from various RPC wrappers
    if (typeof txid.signature === 'string') return txid.signature;
    if (typeof txid.txid === 'string') return txid.txid;
    if (typeof txid.result === 'string') return txid.result;
    if (typeof txid.value === 'string') return txid.value;
    // As a last resort, stringify
    try {
      return JSON.stringify(txid);
    } catch (e) {
      return String(txid);
    }
  }
  return String(txid);
}

function resolveSwapProvider({ swapConfig } = {}) {
  const raw = process.env.SWAP_API_PROVIDER || (swapConfig && swapConfig.swapApiProvider) || '';
  const cleaned = String(raw || '').trim().toLowerCase();
  if (!cleaned) return 'swapV3';
  if (cleaned === 'raptor') return 'raptor';
  if (cleaned === 'swapv3' || cleaned === 'swap-v3' || cleaned === 'v3') return 'swapV3';
  return 'swapV3';
}

function normalizeTxVersionForProvider(txVersion, provider) {
  if (!txVersion) return null;
  const raw = String(txVersion).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (provider === 'raptor') {
    if (lower === 'v0') return raw === 'V0' ? 'V0' : 'v0';
    if (lower === 'legacy') return 'legacy';
    return raw;
  }
  if (lower === 'v0') return 'v0';
  if (lower === 'legacy') return 'legacy';
  return raw;
}

function extractDecimalsFromCoin(coinRow) {
  if (!coinRow) return null;
  const direct = coinRow.decimals;
  if (Number.isFinite(direct)) return Number(direct);

  if (typeof direct === 'string') {
    const trimmed = direct.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && Number.isFinite(parsed.decimals)) return Number(parsed.decimals);
      } catch (err) {
        return null;
      }
    }
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) return asNum;
  }

  if (typeof direct === 'object' && direct) {
    if (Number.isFinite(direct.decimals)) return Number(direct.decimals);
  }

  if (coinRow.token && typeof coinRow.token === 'object' && Number.isFinite(coinRow.token.decimals)) {
    return Number(coinRow.token.decimals);
  }

  return null;
}

async function getMintDecimalsFromBootyBox(bootyBox, mint) {
  if (!bootyBox || typeof bootyBox.getCoinByMint !== 'function') {
    throw new Error('BootyBox.getCoinByMint is required to resolve token decimals');
  }
  const coin = await bootyBox.getCoinByMint(mint);
  return extractDecimalsFromCoin(coin);
}

async function ensureMintDecimals({
  bootyBox,
  mint,
  loggerInstance,
}) {
  const initial = await getMintDecimalsFromBootyBox(bootyBox, mint);
  if (initial != null) return initial;

  let dataClient = null;
  try {
    // eslint-disable-next-line global-require
    const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
    dataClient = createSolanaTrackerDataClient();
  } catch (err) {
    (loggerInstance || logger).warn('[swapWorker] data client unavailable; cannot fetch token metadata', {
      mint,
      err: err?.message || err,
    });
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    const { ensureTokenInfo } = require('../../services/tokenInfoService');
    await ensureTokenInfo({ mint, client: dataClient, forceRefresh: false });
  } catch (err) {
    (loggerInstance || logger).warn('[swapWorker] token metadata fetch failed', {
      mint,
      err: err?.message || err,
    });
    return null;
  }

  return getMintDecimalsFromBootyBox(bootyBox, mint);
}

/**
 * Load a test-only swap executor when SWAP_WORKER_EXECUTOR is configured.
 * @returns {{performTrade: Function}|null}
 */
function loadSwapExecutor() {
  if (swapExecutor) return swapExecutor;
  const executorPath = process.env.SWAP_WORKER_EXECUTOR;
  if (!executorPath) return null;
  const resolved = path.resolve(executorPath);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(resolved);
  if (!mod || typeof mod.performTrade !== 'function') {
    throw new Error(`SWAP_WORKER_EXECUTOR missing performTrade(): ${resolved}`);
  }
  swapExecutor = mod;
  return swapExecutor;
}

function buildTxSummarySeedFromSwapResult(payload, normalized, result, timing, explorerBaseUrl) {
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
    explorerUrl: buildExplorerUrl(txid, explorerBaseUrl),
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
 * Execute a swap request using the configured swap provider.
 *
 * @param {SwapWorkerPayload} payload
 * @param {Object} [tools]
 * @returns {Promise<SwapWorkerResult>}
 */
async function executeSwap(payload, tools = {}) {
  const normalized = validateSwapPayload(payload);
  // Some call-sites provide the alias under different keys. Normalize here so downstream
  // sizing logic and secret resolution always have a wallet alias.
  const resolvedWalletAlias =
    normalized.walletAlias ||
    payload.walletAlias ||
    payload.wallet ||
    payload.wallet_alias ||
    null;

  if (resolvedWalletAlias && !normalized.walletAlias) {
    normalized.walletAlias = resolvedWalletAlias;
  }
  const progress = tools && typeof tools.progress === 'function' ? tools.progress : null;
  if (progress) progress('swap:validated', { mint: normalized.mint, side: normalized.side, detach: normalized.detachMonitor });
  const secret = await resolveWalletSecret(resolvedWalletAlias, normalized.walletPrivateKey);
  if (progress) progress('swap:secret:resolved', { walletAlias: resolvedWalletAlias || null });
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
  const inkMode = Boolean(swapConfig && swapConfig.inkMode);
  const explorerBaseUrl = swapConfig && swapConfig.explorerBaseUrl
    ? String(swapConfig.explorerBaseUrl)
    : null;
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
  const preflight = Boolean(swapConfig && swapConfig.preflight);
  const rpcHttpUrl =
    process.env.SOLANATRACKER_RPC_HTTP_URL ||
    (swapConfig && swapConfig.rpcUrl) ||
    null;
  const maxPriceImpactRaw =
    swapConfig && swapConfig.maxPriceImpact !== undefined ? swapConfig.maxPriceImpact : null;
  let maxPriceImpact = null;
  if (maxPriceImpactRaw !== null && maxPriceImpactRaw !== undefined) {
    const asNum = Number(maxPriceImpactRaw);
    if (Number.isFinite(asNum)) maxPriceImpact = asNum;
  }

  const startedAt = Date.now();

  const walletPubkey =
    normalized.walletPubkey ||
    keypairPubkey;

  if (progress) progress('swap:engine:start', { walletPubkey });

  // Build mint routing
  const fromMint = normalized.side === 'buy' ? WSOL_MINT : normalized.mint;
  const toMint = normalized.side === 'buy' ? normalized.mint : WSOL_MINT;

  // Resolve amount.
  // - BUY: numeric SOL amount
  // - SELL: numeric token amount OR percent/auto sized from current position via BootyBox
  let bootyBox = null;
  if (normalized.side === 'sell' && (isPercentAmount(normalized.amount) || isAutoAmount(normalized.amount))) {
    if (!resolvedWalletAlias) {
      throw new Error('Percent/auto sell sizing requires walletAlias (missing from payload/config).');
    }
    bootyBox = await ensureBootyBoxReady({ inkMode });
  }

  const fromAmountNum = await resolveFromAmountDecimal({
    normalized,
    walletId: normalized.walletId,
    walletAlias: resolvedWalletAlias,
    bootyBox,
    progress,
  });

  if (!Number.isFinite(fromAmountNum) || fromAmountNum <= 0) {
    throw new Error(`swapWorker: resolved fromAmount must be > 0 (got ${String(fromAmountNum)})`);
  }

  const swapProvider = resolveSwapProvider({ swapConfig });

  let swapV3Resp;
  const executor = loadSwapExecutor();
  if (executor) {
    swapV3Resp = await executor.performTrade({
      side: normalized.side,
      mint: normalized.mint,
      amount: normalized.amount,
      walletPubkey,
      slippagePercent,
      priorityFee,
      priorityFeeLevel,
      txVersion,
      useJito,
      jitoTip,
      dryRun: Boolean(normalized.dryRun),
    });
  } else {
    // Create RPC client via existing factory (SolanaTracker RPC).
    // Lazy-require to avoid loading kit RPC until needed.
    // eslint-disable-next-line global-require
    const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
    // eslint-disable-next-line global-require
    const { createRpcMethods } = require('../../solana/rpcMethods');

    const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient({ httpUrl: rpcHttpUrl });
    const rpcMethods = createRpcMethods(rpc, rpcSubs);

    const swapApiBaseUrl =
      swapConfig && (swapConfig.swapApiBaseUrl || swapConfig.swapApiUrl)
        ? swapConfig.swapApiBaseUrl || swapConfig.swapApiUrl
        : '';
    const swapApiKey = swapConfig && swapConfig.swapApiKey ? swapConfig.swapApiKey : '';
    const rpcEndpoint = rpcHttpUrl;
    if (swapProvider === 'raptor' && /swap-v2/i.test(String(swapApiBaseUrl || ''))) {
      logger.warn('[swapWorker] swapApiBaseUrl looks like swap-v2; set it to the Raptor base URL when using raptor.');
    }
    if (swapProvider === 'swapV3' && /raptor/i.test(String(swapApiBaseUrl || ''))) {
      logger.warn('[swapWorker] swapApiBaseUrl looks like Raptor; set swapApiProvider=raptor to use Raptor endpoints.');
    }

    try {
      if (swapProvider === 'raptor') {
        if (!bootyBox) {
          bootyBox = await ensureBootyBoxReady({ inkMode });
        }

        const inputDecimals =
          fromMint === WSOL_MINT ? 9 : await ensureMintDecimals({ bootyBox, mint: fromMint, loggerInstance: logger });
        const outputDecimals =
          toMint === WSOL_MINT ? 9 : await ensureMintDecimals({ bootyBox, mint: toMint, loggerInstance: logger });

        if (debugLogging) {
          logger.debug('[swapWorker] raptor decimals resolved', {
            side: normalized.side,
            fromMint,
            toMint,
            inputDecimals,
            outputDecimals,
            fromIsWsol: fromMint === WSOL_MINT,
            toIsWsol: toMint === WSOL_MINT,
          });
        }

        if (inputDecimals == null) {
          throw new Error(
            `swapRaptor: missing decimals for ${fromMint} (side=${normalized.side}); ensure BootyBox has token metadata`,
          );
        }
        if (outputDecimals == null) {
          logger.warn('[swapWorker] missing output mint decimals; swap will proceed but token deltas may be unavailable', {
            mint: toMint,
          });
        }

        const priorityFeeValue = priorityFee != null ? priorityFee : (priorityFeeLevel || null);
        const priorityFeeSource = priorityFee != null ? 'priorityFee' : (priorityFeeLevel ? 'priorityFeeLevel' : 'none');
        if (debugLogging) {
          logger.info('[swapWorker] raptor priority fee selection', {
            priorityFeeValue,
            priorityFeeSource,
            priorityFee,
            priorityFeeLevel,
          });
        }

        swapV3Resp = await executeSwapRaptor({
          side: normalized.side,
          fromMint,
          toMint,
          fromAmount: fromAmountNum,
          inputDecimals,
          outputDecimals,
          payerAddress: walletPubkey,
          rpc: rpcMethods,
          keyPairs: [keypair],
          swapApiBaseUrl,
          swapApiKey,
          slippagePercent,
          priorityFee: priorityFeeValue,
          txVersion: txVersion || null,
          preflight,
          maxPriceImpactPercent: maxPriceImpact,
          inkMode,
          debugLogging,
          dryRun: Boolean(normalized.dryRun),
          onProgress: progress ? (event, data) => progress(event, data) : null,
        });
      } else {
        const normalizedTxVersion = normalizeTxVersionForProvider(txVersion, swapProvider);
        swapV3Resp = await executeSwapV3({
          side: normalized.side,
          fromMint,
          toMint,
          fromAmount: fromAmountNum,
          payerAddress: walletPubkey,
          rpc: rpcMethods,
          keyPairs: [keypair],
          swapApiBaseUrl,
          swapApiKey,
          slippagePercent,
          priorityFeeLevel: priorityFeeLevel || null,
          txVersion: normalizedTxVersion,
          preflight,
          maxPriceImpactPercent: maxPriceImpact,
          inkMode,
          dryRun: Boolean(normalized.dryRun),
          onProgress: progress ? (event, data) => progress(event, data) : null,
        });
      }
    } catch (err) {
      const msg = err?.message || String(err);
      const cause = err?.cause || null;
      const errCode = err?.code || cause?.code || null;
      const isFetchFailed = /fetch failed/i.test(msg);
      const failureSource = (/swapV3\.buildSwapTx/i.test(msg) || /swapRaptor/i.test(msg) || isFetchFailed)
        ? 'swap-api'
        : 'rpc';
      logger.error('[swapWorker] swap call failed', {
        side: normalized.side,
        fromMint,
        toMint,
        walletPubkey,
        rpcEndpoint,
        swapProvider,
        swapApiBaseUrl,
        authConfigured: Boolean(swapApiKey),
        failureSource,
        errorMessage: msg,
        errorName: err?.name || null,
        errorCode: errCode,
        errorContext: err?.context || null,
        errorSolanaDetails: err?.solanaDetails || null,
        causeMessage: cause?.message || null,
        causeName: cause?.name || null,
        fetchFailed: isFetchFailed,
      });
      throw err;
    } finally {
      try {
        if (typeof close === 'function') close();
      } catch (e) {
        // ignore
      }
    }
  }

  const isDryRun = Boolean(normalized.dryRun || (swapV3Resp && swapV3Resp.dryRun));

  // Adapt swapV3 response to the legacy shape swapWorker expects.
  // NOTE: `quote` is the normalized quote object; `rate` is the passthrough payload from the builder.
  const normalizedTxid = normalizeTxid(swapV3Resp.txid || swapV3Resp.signature);

  const result = {
    txid: normalizedTxid,
    signature: swapV3Resp.signature || normalizedTxid,
    slot: swapV3Resp.slot != null ? swapV3Resp.slot : undefined,
    dryRun: isDryRun,

    // Legacy fields used by downstream logging/summary.
    quote: swapV3Resp.quote || null,
    tokensReceivedDecimal:
      swapV3Resp.tokensReceivedDecimal != null ? Number(swapV3Resp.tokensReceivedDecimal) : undefined,
    solReceivedDecimal:
      swapV3Resp.solReceivedDecimal != null ? Number(swapV3Resp.solReceivedDecimal) : undefined,
    totalFees:
      swapV3Resp.totalFeesSol != null
        ? Number(swapV3Resp.totalFeesSol)
        : swapV3Resp.totalFees != null
          ? Number(swapV3Resp.totalFees)
          : undefined,
    priceImpact:
      swapV3Resp.priceImpactPercent != null
        ? swapV3Resp.priceImpactPercent
        : swapV3Resp.priceImpact != null
          ? swapV3Resp.priceImpact
          : undefined,

    // Keep the old nesting so buildSwapQuoteContext can still find rawQuoteResponse if present.
    swapResponse: {
      rate: swapV3Resp.rate || null,
      raw: swapV3Resp.raw || null,
    },
  };

  const endedAt = Date.now();
  const signature = result.signature || result.txid || null;
  const slot = Number.isFinite(Number(result.slot)) ? Number(result.slot) : null;
  const timing = {
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
  let monitorPayload = null;

  if (!isDryRun && result.txid) {
    if (progress) progress('swap:submitted', { txid: result.txid });
    const monitorContext = {
      txid: result.txid,
      dryRun: isDryRun,
      wallet: walletPubkey || resolvedWalletAlias || null,
      walletAlias: resolvedWalletAlias || null,
      walletId: normalized.walletId !== undefined ? normalized.walletId : null,
      mint: normalized.mint,
      side: normalized.side,
      size: normalized.amount,
      slippagePercent: slippagePercent,
      priorityFeeLevel: priorityFeeLevel || null,
      txVersion: txVersion || null,
      showQuoteDetails,
      debugLogging,
      inkMode,
      rpcEndpoint: rpcHttpUrl || null,
      explorerBaseUrl: explorerBaseUrl || null,
      swapQuote: buildSwapQuoteContext(normalized, result),
      txSummarySeed: buildTxSummarySeedFromSwapResult(normalized, normalized, result, timing, explorerBaseUrl),
    };
    monitorPayload = monitorContext;
  }

  return {
    ...result,
    txid: result.txid || signature,
    signature,
    slot,
    walletPubkey,
    walletAlias: resolvedWalletAlias || null,
    walletId: normalized.walletId !== undefined ? normalized.walletId : null,
    timing,
    monitor: null,
    monitorPayload,
    monitorDetach: normalized.detachMonitor || false,
  };
}

function startHarness() {
  try {
    process.title = 'scoundrel-swapWorker';
  } catch (_) {
    // ignore
  }
  createWorkerHarness(async (payload, tools) => {
    try {
      const result = await executeSwap(payload, tools);
      return result;
    } catch (err) {
      const summary = classifySolanaError(err);
      logger.error('[swapWorker] swap failed', {
        message: err?.message || String(err),
        kind: summary.kind,
        retryable: summary.retryable,
        userMessage: summary.userMessage,
        solanaErrorCode: summary.solanaErrorCode || null,
        programError: summary.programError || null,
      });
      throw err;
    }
  }, {
    workerName: 'swapWorker',
    logger,
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  executeSwap,
};
