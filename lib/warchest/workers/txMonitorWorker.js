'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
const { createRpcMethods } = require('../../solana/rpcMethods');
const { appendHubEvent, DEFAULT_EVENT_PATH } = require('../events');
const TXID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 40; // ~60s

let txInsightService = null;

function getTxInsightService() {
  if (!txInsightService) {
    // eslint-disable-next-line global-require
    txInsightService = require('../../services/txInsightService');
  }
  return txInsightService;
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

function parseLogUpdate(ev, txid) {
  const value = ev && (ev.value || ev.result || ev);
  if (!value) return null;

  const signature = typeof value.signature === 'string' ? value.signature : null;
  if (signature !== txid) return null;

  const context = ev && ev.context ? ev.context : value.context;
  const slot = context && Number.isFinite(Number(context.slot)) ? Number(context.slot) : null;
  const err = Object.prototype.hasOwnProperty.call(value, 'err') ? value.err : null;

  return {
    status: err ? 'failed' : 'confirmed',
    err,
    slot,
  };
}

async function watchViaLogs(txid, wallet, rpcMethods, track) {
  if (!rpcMethods || typeof rpcMethods.subscribeLogs !== 'function' || !wallet) {
    return null;
  }

  return new Promise((resolve) => {
    rpcMethods
      .subscribeLogs(
        { mentions: [wallet] },
        (ev) => {
          const parsed = parseLogUpdate(ev, txid);
          if (parsed) {
            resolve({ ...parsed, unsubscribed: true });
          }
        },
        {
          onError: (err) => {
            logger.warn(
              `[txMonitor] logs subscription error for ${txid}: ${err?.message || err}`
            );
            resolve(null);
          },
        }
      )
      .then((sub) => {
        if (sub && typeof sub.unsubscribe === 'function') {
          track(sub);
        }
      })
      .catch((err) => {
        logger.warn(
          `[txMonitor] failed to subscribe to logs for ${wallet}: ${err?.message || err}`
        );
        resolve(null);
      });
  });
}

async function pollForConfirmation(txid, rpcMethods) {
  if (!rpcMethods || typeof rpcMethods.getTransaction !== 'function') {
    return null;
  }

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const tx = await rpcMethods.getTransaction(txid, { commitment: 'confirmed' });
    if (tx) {
      const slot = Number.isFinite(Number(tx.slot)) ? Number(tx.slot) : null;
      const status = tx.status === 'err' || tx.err ? 'failed' : 'confirmed';
      return { status, err: tx.err || null, slot };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { status: 'timeout', err: new Error('Transaction not found'), slot: null };
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
 * @param {{track?:Function,rpcMethods?:*,rpcClients?:*}} [tools]
 * @returns {Promise<TxMonitorResult>}
 */
async function monitorTransaction(payload, tools = {}) {
  const { track = () => {}, rpcMethods: providedRpcMethods } = tools || {};
  const txid = normalizeTxid(payload.txid);
  const wallet = payload.wallet ? String(payload.wallet).trim() : null;
  const hudEventPath = payload.hudEventPath || DEFAULT_EVENT_PATH;

  let rpcClients = tools.rpcClients || null;
  let rpcMethods = providedRpcMethods || null;

  if (!rpcMethods) {
    rpcClients = rpcClients || loadRpcClients();
    rpcMethods = createRpcMethods(rpcClients.rpc, rpcClients.rpcSubs);
  }

  if (rpcClients && typeof rpcClients.close === 'function') {
    track({ close: rpcClients.close });
  }

  const logResultPromise = rpcMethods
    ? watchViaLogs(txid, wallet, rpcMethods, track)
    : Promise.resolve(null);
  const pollResultPromise = rpcMethods
    ? pollForConfirmation(txid, rpcMethods)
    : Promise.resolve(null);

  const logResult = await logResultPromise;
  let finalResult = logResult || (await pollResultPromise);

  if (!finalResult) {
    finalResult = { status: 'timeout', err: new Error('Unable to determine status'), slot: null };
  }

  let insight = null;
  try {
    const insightSvc = getTxInsightService();
    insight = await insightSvc.recoverSwapInsightFromTransaction(txid, null, {
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
    context: {
      wallet,
      mint: payload.mint || null,
      side: payload.side || null,
      size: payload.size || null,
    },
    insight,
    observedAt: new Date().toISOString(),
  };

  try {
    writeHudEvent(hudEvent, hudEventPath);
  } catch (err) {
    logger.warn(`[txMonitor] failed to write HUD event: ${err?.message || err}`);
  }

  return { ...finalResult, insight };
}

/**
 * Start the worker harness for tx monitor IPC entrypoint.
 * @returns {void}
 */
function startHarness() {
  createWorkerHarness(async (payload, { track }) => monitorTransaction(payload, { track }), {
    exitOnComplete: true,
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
