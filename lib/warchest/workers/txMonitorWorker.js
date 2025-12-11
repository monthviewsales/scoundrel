'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
const { createRpcMethods } = require('../../solana/rpcMethods');
const { appendHubEvent, DEFAULT_EVENT_PATH } = require('../events');
const TXID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
let txInsightService = null;
const DEV_MONITOR_LOG =
  process.env.NODE_ENV === 'development' || process.env.TX_MONITOR_DEBUG === '1';

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
  logger.info(`[txMonitor][trace] ${event}${suffix}`);
}

function getTxInsightService() {
  if (!txInsightService) {
    // eslint-disable-next-line global-require
    txInsightService = require('../../services/txInsightService');
  }
  return txInsightService;
}

let BootyBoxClient = null;
let bootyInitPromise = null;

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

function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

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

function deriveFeesSol(insight, swapQuote = {}) {
  const feeFromInsight = toFiniteNumber(insight && insight.feeSol);
  if (feeFromInsight != null) return feeFromInsight;
  const totalFees = toFiniteNumber(swapQuote.totalFees);
  if (totalFees != null) return totalFees;
  const rateFee = toFiniteNumber(swapQuote.quote && swapQuote.quote.fee);
  if (rateFee != null) return rateFee;
  return null;
}

function buildTradeEventFromInsight(payload, insight) {
  if (!payload || !insight) return null;
  const tokenDeltaNet = toFiniteNumber(insight.tokenDeltaNet);
  const tokenAmount = tokenDeltaNet != null ? Math.abs(tokenDeltaNet) : null;
  if (tokenAmount == null) return null;
  const solAmount = toFiniteNumber(insight.solDeltaNet) ?? 0;
  const side = deriveSideFromInsight(payload, insight, solAmount, tokenDeltaNet);
  const executedAt = toFiniteNumber(insight.executedAt) ?? Date.now();
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

async function persistSwapOutcome(payload, finalResult, insight) {
  if (!payload || payload.walletId == null) return;
  if (!finalResult || finalResult.status !== 'confirmed') return;
  if (!insight) return;

  const booty = await ensureBootyBoxReady();
  if (!booty) return;

  const tradeEvent = buildTradeEventFromInsight(payload, insight);
  if (!tradeEvent) return;

  try {
    await booty.recordScTradeEvent(tradeEvent);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[txMonitor] Failed to record sc_trades row for ${payload.txid}: ${msg}`);
  }

  try {
    await booty.applyScTradeEventToPositions(tradeEvent);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[txMonitor] Failed to update sc_positions for ${payload.txid}: ${msg}`);
  }
}

/**
 * @typedef {Object} TxMonitorPayload
 * @property {string} txid - Transaction signature to watch.
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

function normalizeTxid(txid) {
  const trimmed = String(txid || '').trim();
  if (!TXID_RE.test(trimmed)) {
    throw new Error(`Invalid txid: ${txid}`);
  }
  return trimmed;
}

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

async function watchViaSignature(txid, rpcMethods, track, metricsReporter, { commitment = 'confirmed' } = {}) {
  if (!rpcMethods || typeof rpcMethods.subscribeSignature !== 'function') {
    traceTxMonitor('signature:skip', { txid });
    return null;
  }

  traceTxMonitor('signature:subscribe:start', { txid, commitment });

  return new Promise((resolve) => {
    rpcMethods
      .subscribeSignature(
        txid,
        (ev) => {
          const parsed = parseSignatureUpdate(ev);
          if (parsed) {
            traceTxMonitor('signature:event', { txid, slot: parsed.slot, status: parsed.status });
            resolve({ ...parsed, unsubscribed: true });
          }
        },
        {
          commitment,
          onError: (err) => {
            logger.warn(
              `[txMonitor] signature subscription error for ${txid}: ${err?.message || err}`
            );
            if (metricsReporter) metricsReporter({ event: 'signature:error', txid });
            traceTxMonitor('signature:error', { txid, message: err?.message || String(err) });
            resolve(null);
          },
        }
      )
      .then((sub) => {
        if (sub && typeof sub.unsubscribe === 'function') {
          track(sub);
        }
        traceTxMonitor('signature:subscribe:ready', {
          txid,
          commitment,
          subscriptionId:
            sub && Object.prototype.hasOwnProperty.call(sub, 'subscriptionId')
              ? sub.subscriptionId
              : null,
        });
      })
      .catch((err) => {
        logger.warn(
          `[txMonitor] failed to subscribe to signature ${txid}: ${err?.message || err}`
        );
        if (metricsReporter) metricsReporter({ event: 'signature:subscribe:error', txid });
        traceTxMonitor('signature:subscribe:error', { txid, message: err?.message || String(err) });
        resolve(null);
      });
  });
}

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

/**
 * Append a HUD-friendly transaction event to the configured file.
 *
 * @param {object} event
 * @param {string} [hudEventPath]
 */
function writeHudEvent(event, hudEventPath = DEFAULT_EVENT_PATH) {
  appendHubEvent(event, hudEventPath);
}

/**
 * Monitor a transaction via logs + confirmation and emit HUD events.
 *
 * @param {TxMonitorPayload} payload
 * @param {{track?:Function,rpcMethods?:*,rpcClients?:*,metricsReporter?:Function}} [tools]
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
  const hudContext = {
    wallet,
    mint: payload.mint || null,
    side: payload.side || null,
    size: payload.size || null,
  };

  try {
    signatureResult = await watchViaSignature(txid, rpcMethods, track, metricsReporter, { commitment: 'confirmed' });
    if (!signatureResult) {
      throw new Error(`Signature subscription did not complete for ${txid}`);
    }

    const txDetails = await fetchTransactionOnce(txid, rpcMethods, { commitment: 'confirmed' });
    const slotFromTx = txDetails && Number.isFinite(Number(txDetails.slot)) ? Number(txDetails.slot) : null;
    const slot = slotFromTx != null ? slotFromTx : signatureResult.slot;
    const txErr = extractTxError(txDetails);
    const errPayload = signatureResult.err || txErr || null;
    const status = errPayload ? 'failed' : 'confirmed';
    finalResult = { status, err: errPayload, slot };

    traceTxMonitor('monitor:final', {
      txid,
      status: finalResult.status,
      slot: finalResult.slot,
      signatureSubscriber: Boolean(signatureResult),
    });

    try {
      const insightSvc = getTxInsightService();
      insight = await insightSvc.recoverSwapInsightFromTransaction(txid, txDetails, {
        walletAddress: wallet,
        mint: payload.mint,
      });
    } catch (err) {
      logger.warn(`[txMonitor] insight recovery failed for ${txid}: ${err?.message || err}`);
    }

    const hudEvent = {
      txid,
      status: finalResult.status,
      slot: finalResult.slot,
      err: finalResult.err || null,
      context: hudContext,
      insight,
      swapQuote: payload.swapQuote || null,
      observedAt: new Date().toISOString(),
    };

    try {
      writeHudEvent(hudEvent, hudEventPath);
    } catch (err) {
      logger.warn(`[txMonitor] failed to write HUD event: ${err?.message || err}`);
      if (metricsReporter) metricsReporter({ event: 'hud:write:error', txid });
    }

    await persistSwapOutcome(payload, finalResult, insight);

    return { ...finalResult, insight };
  } catch (err) {
    const fallback = finalResult || { status: 'failed', err, slot: null };
    traceTxMonitor('monitor:error', { txid, message: err?.message || String(err) });

    const hudEvent = {
      txid,
      status: fallback.status || 'failed',
      slot: fallback.slot || null,
      err: fallback.err || { message: err?.message || String(err) },
      context: hudContext,
      insight: null,
      swapQuote: payload.swapQuote || null,
      observedAt: new Date().toISOString(),
    };

    try {
      writeHudEvent(hudEvent, hudEventPath);
    } catch (writeErr) {
      logger.warn(`[txMonitor] failed to write HUD event after error: ${writeErr?.message || writeErr}`);
      if (metricsReporter) metricsReporter({ event: 'hud:write:error', txid });
    }

    throw err;
  }
}

/**
 * Start the worker harness for tx monitor IPC entrypoint.
 * @returns {void}
 */
function startHarness() {
  createWorkerHarness(async (payload, { track }) => monitorTransaction(payload, { track }), {
    exitOnComplete: true,
    workerName: 'txMonitor',
    metricsReporter: (event) => {
      logger.debug?.(`[txMonitor][metrics] ${JSON.stringify(event)}`);
    },
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  monitorTransaction,
  writeHudEvent,
  startHarness,
};
