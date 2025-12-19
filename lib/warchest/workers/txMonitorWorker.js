'use strict';

const path = require('path');

const logger = require('../../logger');
const txLog = typeof logger.txMonitor === 'function' ? logger.txMonitor() : logger;
const chalk = require('chalk');
const { createWorkerHarness } = require('./harness');
const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
const { createRpcMethods } = require('../../solana/rpcMethods');
const { appendHubEvent, DEFAULT_EVENT_PATH } = require('../events');
const fs = require('fs');

/**
 * The tx monitor worker observes a swap transaction until Solana reports a
 * terminal state, records the result for BootyBox, and emits HUD-friendly events.
 */
const TXID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const DEV_MONITOR_LOG =
  process.env.TX_MONITOR_DEBUG === '1' || process.env.SAW_RAW === '1';
let txInsightService = null;
let BootyBoxClient = null;
let bootyInitPromise = null;

// -----------------------------------------------------------------------------
// Diagnostics & formatting helpers
// -----------------------------------------------------------------------------

/**
 * Emit verbose trace logs when developer debugging is enabled.
 *
 * @param {string} event - Short label for the trace event.
 * @param {object} [details] - Optional payload that is JSON-stringified.
 * @returns {void}
 */
function traceTxMonitor(event, details) {
  if (!DEV_MONITOR_LOG) return;
  let suffix = '';
  if (details && Object.keys(details).length > 0) {
    try {
      suffix = ` ${JSON.stringify(details)}`;
    } catch (err) {
      suffix = ` ${String(details)}`;
    }
  }
  txLog.debug(`[trace] ${event}${suffix}`);
}

/**
 * Convert rich payloads (Dates, BigInts) into JSON-safe representations.
 *
 * @param {*} value - Value to convert.
 * @returns {*} JSON-safe value.
 */
function toJsonSafe(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (value && typeof value === 'object') {
    if (value instanceof Date) {
      return value.toISOString();
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = toJsonSafe(val);
    }
    return out;
  }
  return value;
}

/**
 * Produce a concise, human-readable string for unexpected errors.
 *
 * @param {*} err - Unknown error-like payload.
 * @returns {string}
 */
function formatMonitorError(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch (_) {
      return String(err);
    }
  }
  return String(err);
}

// -----------------------------------------------------------------------------
// Lazy service loaders
// -----------------------------------------------------------------------------

/**
 * Resolve the insight service lazily to avoid cycles during worker bootstrap.
 *
 * @returns {*} txInsightService module.
 */
function getTxInsightService() {
  if (!txInsightService) {
    // eslint-disable-next-line global-require
    txInsightService = require('../../services/txInsightService');
  }
  return txInsightService;
}

/**
 * Load the BootyBox client without forcing a hard dependency when unavailable.
 *
 * @returns {*} BootyBox client or undefined.
 */
function loadBootyBox() {
  if (BootyBoxClient !== null) return BootyBoxClient;
  try {
    // eslint-disable-next-line global-require
    BootyBoxClient = require('../../../db');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[txMonitor] BootyBox module unavailable: ${msg}`);
    BootyBoxClient = undefined;
  }
  return BootyBoxClient;
}

/**
 * Initialize the BootyBox client once and reuse it across monitor calls.
 *
 * @returns {Promise<*>} Resolved BootyBox client or null on failure.
 */
async function ensureBootyBoxReady() {
  const client = loadBootyBox();
  if (!client || typeof client.init !== 'function') {
    return null;
  }
  if (!bootyInitPromise) {
    bootyInitPromise = client
      .init()
      .then(() => client)
      .catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[txMonitor] BootyBox init failed: ${msg}`);
        bootyInitPromise = null;
        return null;
      });
  }
  return bootyInitPromise;
}

// -----------------------------------------------------------------------------
// Swap math helpers
// -----------------------------------------------------------------------------

/**
 * Convert unknown numeric input into a finite number when possible.
 *
 * @param {*} value - Incoming value from RPC/insight.
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Resolve the logical side (buy/sell) for a transaction.
 *
 * @param {object} payload - Worker payload.
 * @param {object} insight - Insight payload from txInsightService.
 * @param {number|null} solAmount - SOL delta.
 * @param {number|null} tokenDeltaNet - Token delta.
 * @returns {'buy'|'sell'}
 */
function deriveSideFromInsight(payload, insight, solAmount, tokenDeltaNet) {
  if (insight && (insight.side === 'buy' || insight.side === 'sell')) {
    return insight.side;
  }
  if (solAmount != null && solAmount !== 0) {
    return solAmount > 0 ? 'sell' : 'buy';
  }
  if (tokenDeltaNet != null && tokenDeltaNet !== 0) {
    return tokenDeltaNet > 0 ? 'buy' : 'sell';
  }
  if (payload && (payload.side === 'buy' || payload.side === 'sell')) {
    return payload.side;
  }
  return 'buy';
}

/**
 * Derive USD price per token from the swap quote fallback chain.
 *
 * @param {object} [swapQuote={}] - Raw swap quote payload.
 * @returns {number|null}
 */
function derivePriceUsdFromQuote(swapQuote = {}) {
  const rate = swapQuote.quote || null;
  const raw = swapQuote.rawQuoteResponse || (rate && rate.rawQuoteResponse) || null;
  const ratePrice = rate && rate.price ? rate.price : null;
  const rawPrice = raw && raw.price ? raw.price : null;
  const candidates = [
    toFiniteNumber(rate && rate.priceUsd),
    toFiniteNumber(rate && rate.price_usd),
    toFiniteNumber(ratePrice && ratePrice.usd),
    toFiniteNumber(swapQuote.priceUsdPerToken),
    toFiniteNumber(raw && raw.priceUsd),
    toFiniteNumber(raw && raw.price_usd),
    toFiniteNumber(rawPrice && rawPrice.usd),
  ];
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  if (raw) {
    const outUsd = toFiniteNumber(raw.outAmountUsd || raw.out_amount_usd);
    const amountOut = toFiniteNumber(rate && rate.amountOut);
    if (outUsd != null && amountOut && amountOut !== 0) {
      return outUsd / amountOut;
    }
    const inUsd = toFiniteNumber(raw.inAmountUsd || raw.in_amount_usd);
    const amountIn = toFiniteNumber(rate && rate.amountIn);
    if (inUsd != null && amountIn && amountIn !== 0) {
      return inUsd / amountIn;
    }
  }
  return null;
}

/**
 * Derive the SOL/USD conversion from the surrounding quote data.
 *
 * @param {object} [swapQuote={}] - Swap quote.
 * @param {number|null} priceSolPerToken - SOL per token.
 * @param {number|null} priceUsdPerToken - USD per token.
 * @returns {number|null}
 */
function deriveSolUsdPriceFromQuote(swapQuote = {}, priceSolPerToken, priceUsdPerToken) {
  const rate = swapQuote.quote || null;
  const ratePrice = rate && rate.price ? rate.price : null;
  const raw = swapQuote.rawQuoteResponse || null;
  const rawPrice = raw && raw.price ? raw.price : null;
  const candidates = [
    toFiniteNumber(swapQuote.solUsdPrice),
    toFiniteNumber(raw && raw.solUsdPrice),
    toFiniteNumber(raw && raw.sol_usd_price),
    ratePrice && toFiniteNumber(ratePrice.usd) != null && toFiniteNumber(ratePrice.quote) != null
      ? toFiniteNumber(ratePrice.usd) / toFiniteNumber(ratePrice.quote)
      : null,
    rawPrice && toFiniteNumber(rawPrice.usd) != null && toFiniteNumber(rawPrice.quote) != null
      ? toFiniteNumber(rawPrice.usd) / toFiniteNumber(rawPrice.quote)
      : null,
  ];
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  if (priceSolPerToken && priceUsdPerToken) {
    return priceUsdPerToken / priceSolPerToken;
  }
  return null;
}

/**
 * Determine fee totals expressed in SOL, preferring the most precise source.
 *
 * @param {object} insight - Insight payload.
 * @param {object} [swapQuote={}] - Swap quote payload.
 * @returns {number|null}
 */
function deriveFeesSol(insight, swapQuote = {}) {
  const feeFromInsight = toFiniteNumber(insight && insight.feeSol);
  if (feeFromInsight != null) return feeFromInsight;
  const totalFees = toFiniteNumber(swapQuote.totalFees);
  if (totalFees != null) return totalFees;
  const rateFee = toFiniteNumber(swapQuote.quote && swapQuote.quote.fee);
  if (rateFee != null) return rateFee;
  return null;
}

/**
 * Transform an insight back into the trade event stored by BootyBox.
 *
 * @param {TxMonitorPayload} payload - Worker payload.
 * @param {object} insight - Swap insight payload.
 * @param {object} [txDetails] - Optional transaction details for blockTime.
 * @returns {object|null}
 */
function buildTradeEventFromInsight(payload, insight, txDetails) {
  if (!payload || !insight) return null;
  const tokenDeltaNet = toFiniteNumber(insight.tokenDeltaNet);
  const tokenAmount = tokenDeltaNet != null ? Math.abs(tokenDeltaNet) : null;
  if (tokenAmount == null) return null;
  const solAmount = toFiniteNumber(insight.solDeltaNet) ?? 0;
  const side = deriveSideFromInsight(payload, insight, solAmount, tokenDeltaNet);
  // Prefer blockTime from txDetails, fallback to insight.executedAt if positive, else Date.now()
  const blockTime = txDetails && Object.prototype.hasOwnProperty.call(txDetails, 'blockTime')
    ? toFiniteNumber(txDetails.blockTime)
    : null;
  const executedAtFromBlockTime = blockTime != null && blockTime > 0 ? blockTime * 1000 : null;

  const executedAtCandidate = toFiniteNumber(insight.executedAt);
  const executedAt =
    executedAtFromBlockTime != null
      ? executedAtFromBlockTime
      : executedAtCandidate != null && executedAtCandidate > 0
        ? executedAtCandidate
        : Date.now();
  const swapQuote = payload.swapQuote || null;
  let priceSolPerToken = toFiniteNumber(insight.priceSolPerToken);
  if ((priceSolPerToken == null || priceSolPerToken === 0) && swapQuote && swapQuote.quote) {
    const quotePrice = toFiniteNumber(swapQuote.quote.price && swapQuote.quote.price.quote);
    if (quotePrice != null) {
      priceSolPerToken = quotePrice;
    }
  }
  if ((priceSolPerToken == null || priceSolPerToken === 0) && tokenAmount > 0 && solAmount != null) {
    priceSolPerToken = Math.abs(solAmount) / tokenAmount;
  }
  const priceUsdPerToken = derivePriceUsdFromQuote(swapQuote);
  const solUsdPrice = deriveSolUsdPriceFromQuote(swapQuote, priceSolPerToken, priceUsdPerToken);
  const feesSol = deriveFeesSol(insight, swapQuote);
  const feesUsd =
    feesSol != null && solUsdPrice != null ? feesSol * solUsdPrice : null;
  const slippagePct =
    toFiniteNumber(payload.slippagePercent) ??
    toFiniteNumber(swapQuote && swapQuote.slippagePercent);
  const priceImpactPct = toFiniteNumber(swapQuote && swapQuote.priceImpact);
  const coinMint = payload.mint || insight.mint || null;
  if (!coinMint) return null;

  return {
    txid: payload.txid,
    walletId: payload.walletId,
    walletAlias: payload.walletAlias || null,
    coinMint,
    side,
    executedAt,
    tokenAmount,
    solAmount,
    priceSolPerToken,
    priceUsdPerToken,
    solUsdPrice,
    feesSol,
    feesUsd,
    slippagePct,
    priceImpactPct,
    program: 'swapEngine',
    decisionPayload: {
      swapQuote,
    },
  };
}

/**
 * Persist a swap that successfully reached confirmation.
 *
 * @param {TxMonitorPayload} payload - Worker payload.
 * @param {TxMonitorResult} finalResult - Final outcome of monitoring.
 * @param {object|null} insight - Swap insight payload.
 * @param {object} [txDetails] - Optional transaction details for blockTime.
 * @returns {Promise<void>}
 */
async function persistSwapOutcome(payload, finalResult, insight, txDetails) {
  if (!payload || payload.walletId == null) return;
  if (!finalResult || finalResult.status !== 'confirmed') return;
  if (!insight) return;

  const booty = await ensureBootyBoxReady();
  if (!booty) return;

  const tradeEvent = buildTradeEventFromInsight(payload, insight, txDetails);
  if (!tradeEvent) return;

  try {
    // recordScTradeEvent is the single-writer entry point and now also keeps sc_positions in sync.
    if (DEV_MONITOR_LOG) {
      txLog.debug(
        `${chalk.bgYellow.black('[ScTradeEvent] ')}${JSON.stringify(toJsonSafe(tradeEvent), null, 2)}`,
      );
    }
    await booty.recordScTradeEvent(tradeEvent);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[txMonitor] Failed to record sc_trades row for ${payload.txid}: ${msg}`);
  }
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} TxMonitorPayload
 * @property {string} txid - Transaction signature to watch.
 * @property {object} [txSummarySeed] - Optional precomputed tx summary fields (from swapWorker) for UI rendering.
 * @property {string} [wallet] - Optional fee payer/base wallet for log filtering and insight recovery.
 * @property {string} [mint] - Optional token mint for HUD context.
 * @property {'buy'|'sell'} [side] - Swap side for HUD context.
 * @property {number|string} [size] - Swap size/amount for HUD context.
 * @property {string} [hudEventPath] - Optional override for HUD event file location.
 */

/**
 * @typedef {Object} TxMonitorResult
 * @property {'confirmed'|'failed'|'timeout'} status - Final status derived from logs/confirmation.
 * @property {*} [err] - RPC meta.err or log error payload when failed.
 * @property {number|null} slot - Slot reported by log context or confirmed transaction.
 * @property {object|null} [insight] - Swap insight from txInsightService when available.
 */

// -----------------------------------------------------------------------------
// RPC utilities
// -----------------------------------------------------------------------------

/**
 * Validate and normalize a provided transaction signature.
 *
 * @param {string} txid - User-provided signature.
 * @returns {string}
 */
function normalizeTxid(txid) {
  const trimmed = String(txid || '').trim();
  if (!TXID_RE.test(trimmed)) {
    throw new Error(`Invalid txid: ${txid}`);
  }
  return trimmed;
}

/**
 * Build RPC clients either from the default SolanaTracker factory or a custom factory path.
 *
 * @returns {{rpc:*,rpcSubs:*,close:Function}}
 */
function loadRpcClients() {
  if (process.env.TX_MONITOR_RPC_FACTORY) {
    const factoryPath = process.env.TX_MONITOR_RPC_FACTORY;
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const factory = require(path.isAbsolute(factoryPath)
      ? factoryPath
      : path.join(process.cwd(), factoryPath));
    if (typeof factory !== 'function') {
      throw new Error('TX_MONITOR_RPC_FACTORY must export a function');
    }
    const res = factory();
    if (!res || !res.rpc || !res.rpcSubs || typeof res.close !== 'function') {
      throw new Error('TX_MONITOR_RPC_FACTORY must return { rpc, rpcSubs, close }');
    }
    return res;
  }

  return createSolanaTrackerRPCClient();
}

/**
 * Convert a signature subscription update into a normalized structure.
 *
 * @param {*} ev - Raw RPC notification.
 * @returns {{status:'confirmed'|'failed',err:*,slot:number|null}|null}
 */
function parseSignatureUpdate(ev) {
  if (!ev) return null;
  const payload = ev.result || ev.value || ev;
  if (!payload || typeof payload !== 'object') return null;

  const context = payload.context || ev.context || null;
  const slot = context && Number.isFinite(Number(context.slot)) ? Number(context.slot) : null;

  const value = payload.value || payload;
  if (!value || typeof value !== 'object') {
    return { status: 'confirmed', err: null, slot };
  }

  const err = Object.prototype.hasOwnProperty.call(value, 'err') ? value.err : null;
  const status = err ? 'failed' : 'confirmed';

  return { status, err, slot };
}

/**
 * Subscribe to signature/log updates so we can react as soon as the transaction lands.
 *
 * @param {string} txid - Transaction signature.
 * @param {*} rpcMethods - RPC method factory from createRpcMethods.
 * @param {Function} track - Tracking hook for cleanup.
 * @param {Function} [metricsReporter] - Optional metrics callback.
 * @param {{commitment?:string}} [options]
 * @returns {Promise<TxMonitorResult|null>}
 */
async function watchViaSignature(txid, rpcMethods, track, metricsReporter, { commitment = 'confirmed' } = {}) {
  const subscribeSignature = rpcMethods && typeof rpcMethods.subscribeSignature === 'function'
    ? rpcMethods.subscribeSignature
    : null;
  const subscribeLogs = rpcMethods && typeof rpcMethods.subscribeLogs === 'function'
    ? rpcMethods.subscribeLogs
    : null;

  if (!subscribeSignature && !subscribeLogs) {
    traceTxMonitor('signature:skip', { txid });
    return null;
  }

  traceTxMonitor('signature:subscribe:start', {
    txid,
    commitment,
    transport: subscribeSignature ? 'signature' : 'logs',
  });

  return new Promise((resolve) => {
    const onUpdate = (ev) => {
      const parsed = parseSignatureUpdate(ev);
      if (parsed) {
        traceTxMonitor('signature:event', { txid, slot: parsed.slot, status: parsed.status });
        resolve({ ...parsed, unsubscribed: true });
      }
    };

    const onError = (err) => {
      logger.warn(`[txMonitor] signature subscription error for ${txid}: ${err?.message || err}`);
      if (metricsReporter) metricsReporter({ event: 'signature:error', txid });
      traceTxMonitor('signature:error', { txid, message: err?.message || String(err) });
      resolve(null);
    };

    const subscribePromise = subscribeSignature
      ? subscribeSignature(txid, onUpdate, { commitment, onError })
      : subscribeLogs({ mentions: [txid] }, onUpdate, { commitment, onError });

    subscribePromise
      .then((sub) => {
        if (sub && typeof sub.unsubscribe === 'function') {
          track(sub);
        }
        traceTxMonitor('signature:subscribe:ready', {
          txid,
          commitment,
          transport: subscribeSignature ? 'signature' : 'logs',
          subscriptionId:
            sub && Object.prototype.hasOwnProperty.call(sub, 'subscriptionId')
              ? sub.subscriptionId
              : null,
        });
      })
      .catch((err) => {
        logger.warn(`[txMonitor] failed to subscribe to signature ${txid}: ${err?.message || err}`);
        if (metricsReporter) metricsReporter({ event: 'signature:subscribe:error', txid });
        traceTxMonitor('signature:subscribe:error', { txid, message: err?.message || String(err) });
        resolve(null);
      });
  });
}

/**
 * Fetch a confirmed transaction once.
 *
 * @param {string} txid - Signature.
 * @param {*} rpcMethods - RPC method factory.
 * @param {{commitment?:string}} [options]
 * @returns {Promise<object|null>}
 */
async function fetchTransactionOnce(txid, rpcMethods, { commitment = 'confirmed' } = {}) {
  if (!rpcMethods || typeof rpcMethods.getTransaction !== 'function') {
    traceTxMonitor('fetch:skip', { txid });
    return null;
  }

  traceTxMonitor('fetch:start', { txid, commitment });

  try {
    const tx = await rpcMethods.getTransaction(txid, { commitment });
    if (!tx) {
      traceTxMonitor('fetch:empty', { txid });
      return null;
    }
    const slot = Number.isFinite(Number(tx.slot)) ? Number(tx.slot) : null;
    traceTxMonitor('fetch:done', { txid, slot });
    return tx;
  } catch (err) {
    logger.warn(`[txMonitor] getTransaction failed for ${txid}: ${err?.message || err}`);
    traceTxMonitor('fetch:error', { txid, message: err?.message || String(err) });
    return null;
  }
}

/**
 * Poll the RPC for a transaction until we succeed or exhaust attempts.
 *
 * @param {string} txid - Signature.
 * @param {*} rpcMethods - RPC method factory.
 * @param {{commitment?:string,attempts?:number,retryDelayFn?:Function}} [options]
 * @returns {Promise<object|null>}
 */
async function fetchTransactionWithRetry(
  txid,
  rpcMethods,
  { commitment = 'confirmed', attempts = 3, retryDelayFn } = {}
) {
  const totalAttempts = Number.isFinite(Number(attempts)) && Number(attempts) > 0 ? Number(attempts) : 3;
  const delayFn = typeof retryDelayFn === 'function'
    ? retryDelayFn
    : (delayMs = 50) => new Promise((resolve) => setTimeout(resolve, delayMs));

  let lastTx = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    lastTx = await fetchTransactionOnce(txid, rpcMethods, { commitment });
    if (lastTx) return lastTx;
    if (attempt < totalAttempts) {
      await delayFn();
    }
  }

  return lastTx;
}

/**
 * Extract meta.err from an RPC transaction.
 *
 * @param {object|null} tx - Transaction payload.
 * @returns {*|null}
 */
function extractTxError(tx) {
  if (!tx || typeof tx !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(tx, 'err')) {
    return tx.err;
  }
  if (tx.meta && Object.prototype.hasOwnProperty.call(tx.meta, 'err')) {
    return tx.meta.err;
  }
  return null;
}

function buildExplorerUrl(txid) {
  const base = process.env.SOLANA_EXPLORER_BASE_URL || 'https://solscan.io/tx';
  return txid ? `${base}/${txid}` : null;
}

function toIsoBlockTime(txDetails) {
  if (!txDetails || typeof txDetails !== 'object') return null;
  const bt = Object.prototype.hasOwnProperty.call(txDetails, 'blockTime')
    ? toFiniteNumber(txDetails.blockTime)
    : null;
  if (bt != null && bt > 0) {
    try {
      return new Date(bt * 1000).toISOString();
    } catch (_) {
      return null;
    }
  }
  return null;
}

function finalizeTxSummary(seed, { txid, finalResult, txDetails, insight }) {
  const base = seed && typeof seed === 'object' ? { ...seed } : {};

  const confirmed = finalResult && finalResult.status === 'confirmed';
  const failed = finalResult && finalResult.status === 'failed';
  const processed = !confirmed && !failed;

  const err = failed ? (finalResult && finalResult.err ? finalResult.err : null) : null;
  const errMessage = err ? formatMonitorError(err) : '';

  const status = confirmed ? 'ok' : failed ? 'failed' : processed ? 'processed' : 'unknown';

  let label = base.label || 'transaction';
  if (confirmed && /submitted/i.test(label)) label = label.replace(/submitted/i, 'confirmed');
  if (failed && /submitted/i.test(label)) label = label.replace(/submitted/i, 'failed');

  return {
    kind: base.kind || (base.side ? 'swap' : 'tx'),
    status,
    statusCategory: confirmed ? 'confirmed' : failed ? 'failed' : processed ? 'processed' : 'unknown',
    label,
    side: base.side || null,
    mint: base.mint || null,

    txid: base.txid || txid,
    explorerUrl: base.explorerUrl || buildExplorerUrl(base.txid || txid),
    slot: base.slot != null ? base.slot : (finalResult && finalResult.slot != null ? finalResult.slot : null),
    blockTimeIso: base.blockTimeIso || toIsoBlockTime(txDetails),
    durationMs: base.durationMs != null ? base.durationMs : null,

    // swap-ish metrics (prefer seed; fall back to already-available insight)
    tokens:
      base.tokens != null
        ? base.tokens
        : (insight && toFiniteNumber(insight.tokenDeltaNet) != null ? Math.abs(toFiniteNumber(insight.tokenDeltaNet)) : null),
    sol:
      base.sol != null
        ? base.sol
        : (insight && toFiniteNumber(insight.solDeltaNet) != null ? toFiniteNumber(insight.solDeltaNet) : null),
    totalFeesSol:
      base.totalFeesSol != null
        ? base.totalFeesSol
        : (insight && toFiniteNumber(insight.feeSol) != null ? toFiniteNumber(insight.feeSol) : null),
    priceImpactPct: base.priceImpactPct != null ? base.priceImpactPct : null,
    quote: Object.prototype.hasOwnProperty.call(base, 'quote') ? base.quote : undefined,

    // error details for UI / card rendering
    err,
    errMessage,

    // normalized status info for HUD rendering
    statusEmoji: confirmed ? '🟢' : failed ? '🔴' : '🟡',
  };
}

// -----------------------------------------------------------------------------
// HUD events
// -----------------------------------------------------------------------------

/**
 * Append a HUD-friendly transaction event to the configured file.
 *
 * @param {object} event - Event payload.
 * @param {string} [hudEventPath]
 * @returns {void}
 */
function writeHudEvent(event, hudEventPath = DEFAULT_EVENT_PATH) {
  appendHubEvent(event, hudEventPath);
}

// -----------------------------------------------------------------------------
// Core worker flow
// -----------------------------------------------------------------------------

/**
 * Monitor a transaction via logs + confirmation and emit HUD events.
 *
 * @param {TxMonitorPayload} payload - Job payload.
 * @param {{track?:Function,rpcMethods?:*,rpcClients?:*,metricsReporter?:Function,retryOptions?:object,retryDelayFn?:Function}} [tools]
 * @throws {Error} When signature monitoring or transaction fetch fails.
 * @returns {Promise<TxMonitorResult>}
 */
async function monitorTransaction(payload, tools = {}) {
  const { track = () => {}, rpcMethods: providedRpcMethods } = tools || {};
  const txid = normalizeTxid(payload.txid);
  const wallet = payload.wallet ? String(payload.wallet).trim() : null;
  const hudEventPath = payload.hudEventPath || DEFAULT_EVENT_PATH;
  const metricsReporter = typeof tools.metricsReporter === 'function'
    ? (event) => tools.metricsReporter({ worker: 'txMonitor', ...event })
    : null;

  let rpcClients = tools.rpcClients || null;
  let rpcMethods = providedRpcMethods || null;

  if (!rpcMethods) {
    rpcClients = rpcClients || loadRpcClients();
    rpcMethods = createRpcMethods(rpcClients.rpc, rpcClients.rpcSubs);
  }

  if (rpcClients && typeof rpcClients.close === 'function') {
    track({ close: rpcClients.close });
  }

  let finalResult = null;
  let insight = null;
  let signatureResult = null;
  let txDetails = null;
  const hudContext = {
    wallet,
    mint: payload.mint || null,
    side: payload.side || null,
    size: payload.size || null,
  };

  const txSummarySeed =
    payload && payload.txSummarySeed && typeof payload.txSummarySeed === 'object'
      ? payload.txSummarySeed
      : null;

  try {
    // 1. Wait for subscription confirmation so we know RPC saw the txid.
    signatureResult = await watchViaSignature(txid, rpcMethods, track, metricsReporter, { commitment: 'confirmed' });

    // 2. If the subscription never triggered we still try to fetch the transaction directly.
    if (!signatureResult) {
      txDetails = await fetchTransactionWithRetry(txid, rpcMethods, {
        commitment: 'confirmed',
        attempts: tools.retryOptions && tools.retryOptions.attempts,
        retryDelayFn: tools.retryDelayFn,
      });
      if (!txDetails) {
        throw new Error(`Retry failed: Signature subscription did not complete for ${txid}`);
      }
    }

    // 3. Grab the latest transaction data once the RPC is confident it landed.
    if (!txDetails) {
      txDetails = await fetchTransactionOnce(txid, rpcMethods, { commitment: 'confirmed' });
    }

    const slotFromTx = txDetails && Number.isFinite(Number(txDetails.slot)) ? Number(txDetails.slot) : null;
    const txErr = extractTxError(txDetails);
    const slot = slotFromTx != null ? slotFromTx : signatureResult?.slot || null;
    const errPayload = (signatureResult && signatureResult.err) || txErr || null;
    const status = errPayload ? 'failed' : 'confirmed';
    finalResult = { status, err: errPayload, slot };

    traceTxMonitor('monitor:final', {
      txid,
      status: finalResult.status,
      slot: finalResult.slot,
      signatureSubscriber: Boolean(signatureResult),
    });
    const statusEmoji = summary.statusEmoji || (finalResult.status === 'confirmed' ? '🟢' : finalResult.status === 'failed' ? '🔴' : '🟡');
    const errMessage = finalResult.err ? ` reason=${formatMonitorError(finalResult.err)}` : '';
    logger.debug(`[txMonitor] ${statusEmoji} ${txid} ${finalResult.status}${errMessage}`);

    try {
      const insightSvc = getTxInsightService();
      insight = await insightSvc.recoverSwapInsightFromTransaction(txid, txDetails, {
        walletAddress: wallet,
        mint: payload.mint,
      });
    } catch (err) {
      logger.warn(`[txMonitor] insight recovery failed for ${txid}: ${err?.message || err}`);
    }

    const txSummary = finalizeTxSummary(txSummarySeed, { txid, finalResult, txDetails, insight });

    const hudEvent = {
      txid,
      status: finalResult.status,
      statusCategory: txSummary.statusCategory,
      statusEmoji: txSummary.statusEmoji,
      slot: finalResult.slot,
      txSummary,
      err: finalResult.err || null,
      context: hudContext,
      insight,
      swapQuote: payload.swapQuote || null,
      observedAt: new Date().toISOString(),
    };

    try {
      writeHudEvent(toJsonSafe(hudEvent), hudEventPath);
    } catch (err) {
      logger.warn(`[txMonitor] failed to write HUD event: ${err?.message || err}`);
      if (metricsReporter) metricsReporter({ event: 'hud:write:error', txid });
    }

    await persistSwapOutcome(payload, finalResult, insight, txDetails);

    return toJsonSafe({ ...finalResult, insight, txSummary });
  } catch (err) {
    const fallback = finalResult || { status: 'failed', err, slot: null };
    const txSummary = finalizeTxSummary(txSummarySeed, { txid, finalResult: fallback, txDetails: null, insight: null });
    traceTxMonitor('monitor:error', { txid, message: err?.message || String(err) });

    const hudEvent = {
      txid,
      status: fallback.status || 'failed',
      statusCategory: txSummary.statusCategory,
      statusEmoji: txSummary.statusEmoji,
      slot: fallback.slot || null,
      txSummary,
      err: fallback.err || { message: err?.message || String(err) },
      context: hudContext,
      insight: null,
      swapQuote: payload.swapQuote || null,
      observedAt: new Date().toISOString(),
    };

    try {
      writeHudEvent(toJsonSafe(hudEvent), hudEventPath);
    } catch (writeErr) {
      logger.warn(`[txMonitor] failed to write HUD event after error: ${writeErr?.message || writeErr}`);
      if (metricsReporter) metricsReporter({ event: 'hud:write:error', txid });
    }
    logger.warn(`[txMonitor] ❌ monitor error for ${txid}: ${err?.message || err}`);

    throw err;
  }
}

/**
 * Start the worker harness for tx monitor IPC entrypoint.
 *
 * @returns {void}
 */
function startHarness() {
  createWorkerHarness(async (payload, { track }) => monitorTransaction(payload, { track }), {
    exitOnComplete: true,
    workerName: 'txMonitor',
    metricsReporter: (event) => {
      const metricsLog = typeof logger.metrics === 'function' ? logger.metrics() : logger;
      metricsLog.debug?.(`txMonitor ${JSON.stringify(event)}`);
    },
  });
}

function parseStandaloneArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const out = { payloadBase64: null, payloadFile: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--payload-base64') {
      out.payloadBase64 = args[i + 1] || null;
      i += 1;
    } else if (arg === '--payload-file') {
      out.payloadFile = args[i + 1] || null;
      i += 1;
    }
  }
  return out;
}

/**
 * Run tx monitoring in standalone mode (no IPC), used for detached background monitoring.
 *
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function runStandalone(payload) {
  const cleanupResources = new Set();
  const track = (resource) => {
    if (resource) cleanupResources.add(resource);
    return resource;
  };

  try {
    await monitorTransaction(payload, { track });
  } finally {
    for (const resource of cleanupResources) {
      if (resource && typeof resource.close === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await resource.close();
      }
      if (resource && typeof resource.unsubscribe === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await resource.unsubscribe();
      }
    }
    cleanupResources.clear();
  }
}

if (require.main === module) {
  const standaloneArgs = parseStandaloneArgs(process.argv);
  if (standaloneArgs.payloadBase64 || standaloneArgs.payloadFile) {
    (async () => {
      let payload = null;
      if (standaloneArgs.payloadFile) {
        payload = JSON.parse(fs.readFileSync(standaloneArgs.payloadFile, 'utf8'));
      } else {
        const raw = Buffer.from(String(standaloneArgs.payloadBase64), 'base64').toString('utf8');
        payload = JSON.parse(raw);
      }
      await runStandalone(payload);
      process.exit(0);
    })().catch((err) => {
      logger.error(`[txMonitor] standalone failed: ${err?.message || err}`);
      process.exit(1);
    });
  } else {
    startHarness();
  }
}

module.exports = {
  monitorTransaction,
  writeHudEvent,
  startHarness,
};
