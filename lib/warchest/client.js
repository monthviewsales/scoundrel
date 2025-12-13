'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { createSolanaTrackerRPCClient } = require('../solanaTrackerRPCClient');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const { createRpcMethods } = require('../solana/rpcMethods');
const { resolveWalletSpecsWithRegistry } = require('./walletResolver');

const DEFAULT_STATUS_ROOT = path.join(process.cwd(), 'data', 'warchest');
const STATUS_FILE = 'status.json';

/**
 * @typedef {Object} TokenRow
 * @property {string} symbol
 * @property {string} mint
 * @property {number} balance
 * @property {number} sessionDelta
 * @property {number|null} usdEstimate
 * @property {number|null} decimals
 */

/**
 * @typedef {Object} WalletState
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} color
 * @property {number|undefined} walletId
 * @property {number|null} startSolBalance
 * @property {number} solBalance
 * @property {number} solSessionDelta
 * @property {number} openedAt
 * @property {number} lastActivityTs
 * @property {Object<string, number>} startTokenBalances
 * @property {TokenRow[]} tokens
 * @property {boolean|null} hasToken22
 * @property {{ts:number,summary:string}[]} recentEvents
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
    // BootyBox index should select the appropriate adapter (MySQL/SQLite).
    // If it is not available in this environment, we fall back to a no-op
    // object so WalletManagerV2 can still run without persisting trades.
    // Adjust the require path if your BootyBox entrypoint lives elsewhere.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    BootyBox = require('../../db');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] BootyBox module not available for WalletManagerV2: ${msg}`);
    throw new Error('BootyBox client unavailable; warchest cannot persist trades.');
  }

  if (!BootyBox || typeof BootyBox.init !== 'function') {
    throw new Error('BootyBox client unavailable; warchest cannot persist trades.');
  }

  try {
    await BootyBox.init();
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] BootyBox init failed; persistence disabled: ${msg}`);
    throw new Error('BootyBox init failed.');
  }

  const missing = [];
  // recordScTradeEvent is the single-writer entry point and is responsible for keeping sc_positions in sync.
  if (typeof BootyBox.recordScTradeEvent !== 'function') missing.push('recordScTradeEvent');

  if (missing.length) {
    logger.error(
      `[HUD] BootyBox missing required helpers (${missing.join(', ')}); warchest persistence disabled.`,
    );
    throw new Error('BootyBox missing required helpers.');
  }

  // Optional helpers: used by discovery/resync flows; warn but do not disable persistence.
  if (typeof BootyBox.ensureOpenPositionRun !== 'function') {
    logger.warn(
      '[HUD] BootyBox.ensureOpenPositionRun is not available; external/discovery holdings may not get a position-run trade_uuid until the first in-app trade.'
    );
  }

  return BootyBox;
}

/**
 * Build initial HUD state from CLI wallets.
 * In v1, tokens are just an empty list (to be filled later).
 *
 * @param {{alias:string,pubkey:string,color:string|null,walletId?:number}[]} walletSpecs
 * @returns {Record<string,WalletState>}
 */
function buildInitialState(walletSpecs) {
  const now = Date.now();
  const state = {};
  for (const w of walletSpecs) {
    state[w.alias] = {
      alias: w.alias,
      pubkey: w.pubkey,
      color: w.color || null,
      walletId: w.walletId,
      startSolBalance: null,
      solBalance: 0,
      solSessionDelta: 0,
      openedAt: now,
      lastActivityTs: now,
      startTokenBalances: {},
      tokens: [],
      hasToken22: null,
      recentEvents: [],
    };
  }
  return state;
}

/**
 * Persist a lightweight health snapshot for other commands to read.
 * This is only used in daemon mode; HUD mode is ephemeral.
 *
 * @param {object} health
 * @param {string} statusDir
 * @returns {void}
 */
function writeStatusSnapshot(health, statusDir) {
  if (!health) return;

  const dir = statusDir || DEFAULT_STATUS_ROOT;
  const statusPath = path.join(dir, STATUS_FILE);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const snapshot = {
      updatedAt: new Date().toISOString(),
      health,
    };

    fs.writeFileSync(statusPath, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to write warchest status snapshot: ${msg}`);
  }
}

/**
 * Set up shared warchest clients and HUD state.
 *
 * @param {Object} opts
 * @param {{alias:string,pubkey:string,color:string|null}[]} opts.walletSpecs
 * @param {('hud'|'daemon')} opts.mode
 * @param {string} [opts.statusDir] - Directory for status snapshots (defaults to data/warchest)
 * @returns {Promise<{state:Record<string,WalletState>, resolvedWallets:Array, rpc:*, rpcSubs:*, rpcMethods:*, dataClient:*, bootyBox:object, rpcStats:{lastSolMs:number|null,lastTokenMs:number|null,lastDataApiMs:number|null}, trackInterval:Function, trackSubscription:Function, close:Function, writeStatusSnapshot:Function}>}
 */
async function setup(opts) {
  const { walletSpecs, mode, statusDir } = opts || {};
  if (!Array.isArray(walletSpecs) || walletSpecs.length === 0) {
    throw new Error('No wallets provided. Use --wallet alias:pubkey:color');
  }

  const bootyBox = await ensureBootyBoxReady();
  const resolvedWallets = await resolveWalletSpecsWithRegistry(walletSpecs, bootyBox);
  if (!resolvedWallets.length) {
    throw new Error('No wallets could be resolved against sc_wallets.');
  }

  const state = buildInitialState(resolvedWallets);
  const rpcStats = {
    lastSolMs: null,
    lastTokenMs: null,
    lastDataApiMs: null,
  };

  const timers = new Set();
  const subscriptions = new Set();

  const dataClient = createSolanaTrackerDataClient();
  const { rpc, rpcSubs, close: closeRpc } = createSolanaTrackerRPCClient();
  const rpcMethods = createRpcMethods(rpc, rpcSubs);

  /**
   * Track an interval for cleanup.
   * @param {NodeJS.Timeout|null|undefined} timer
   */
  function trackInterval(timer) {
    if (timer) timers.add(timer);
  }

  /**
   * Track a subscription for cleanup.
   * @param {{unsubscribe:Function}|null|undefined} sub
   */
  function trackSubscription(sub) {
    if (sub) subscriptions.add(sub);
  }

  /**
   * Close RPC connections and cleanup tracked resources.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    for (const timer of timers) {
      clearInterval(timer);
    }
    timers.clear();

    for (const sub of subscriptions) {
      try {
        if (sub && typeof sub.unsubscribe === 'function') {
          // eslint-disable-next-line no-await-in-loop
          await sub.unsubscribe();
        }
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Error during subscription unsubscribe: ${msg}`);
      }
    }
    subscriptions.clear();

    if (typeof closeRpc === 'function') {
      try {
        await closeRpc();
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Error during RPC client close: ${msg}`);
      }
    }
  }

  const snapshotWriter = mode === 'daemon'
    ? (health) => writeStatusSnapshot(health, statusDir || DEFAULT_STATUS_ROOT)
    : () => {};

  return {
    state,
    resolvedWallets,
    rpc,
    rpcSubs,
    rpcMethods,
    dataClient,
    bootyBox,
    rpcStats,
    trackInterval,
    trackSubscription,
    close,
    writeStatusSnapshot: snapshotWriter,
  };
}

module.exports = {
  buildInitialState,
  ensureBootyBoxReady,
  setup,
  writeStatusSnapshot,
};
