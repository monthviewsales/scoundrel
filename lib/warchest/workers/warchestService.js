#!/usr/bin/env node
'use strict';

// lib/warchest/workers/warchestService.js
// Long-running HUD worker: given wallet info via CLI args,
// connect to SolanaTracker RPC, maintain simple state, and render a
// multi-wallet dashboard in the terminal.


require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const React = require('react');

const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
const { createRpcMethods } = require('../../solana/rpcMethods');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
const { ensureTokenInfo } = require('../../services/tokenInfoService');
const logger = require('../../logger');
const { updateFromSlotEvent } = require('../../solana/rpcMethods/internal/chainState');
const { updateSol } = require('../../solana/rpcMethods/internal/walletState');
const { createWarchestApp } = require('../../hud/warchestInkApp');
const { createHudStore } = require('../../hud/hudStore');
const { updateHealth } = require('../health');
const { fetchAllTokenAccounts } = require('../fetchAllTokenAccounts');
const { resolveWalletSpecsWithRegistry } = require('../../wallets/resolver');

const WalletManagerV2 = require('../../WalletManagerV2');
const txInsightService = require('../../services/txInsightService');

let inkModulePromise = null;

/**
 * Dynamically import Ink's ESM module so this CommonJS worker can render the HUD without
 * triggering ERR_REQUIRE_ASYNC_MODULE errors in Node >=18.
 *
 * @returns {Promise<object>} resolved Ink module (with render/exported helpers)
 */
async function loadInkModule() {
  if (!inkModulePromise) {
    inkModulePromise = import('ink').catch((err) => {
      inkModulePromise = null;
      throw err;
    });
  }

  return inkModulePromise;
}

let BootyBox = {};
try {
  // BootyBox index should select the appropriate adapter (MySQL/SQLite).
  // If it is not available in this environment, we fall back to a no-op
  // object so WalletManagerV2 can still run without persisting trades.
  // Adjust the require path if your BootyBox entrypoint lives elsewhere.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  BootyBox = require('../../../db');
} catch (err) {
  const msg = err && err.message ? err.message : err;
  logger.warn(`[HUD] BootyBox module not available for WalletManagerV2: ${msg}`);
  BootyBox = {};
}

/**
 * Ensure the BootyBox adapter is ready before processing trades.
 * This guards against silent failures when the submodule is missing or the
 * adapter has not been initialised, and verifies that the warchest-specific
 * helpers we rely on are present.
 *
 * @returns {Promise<boolean>} true if BootyBox is usable, false otherwise
 */
async function ensureBootyBoxReady() {
  if (!BootyBox || typeof BootyBox.init !== 'function') {
    logger.error('[HUD] BootyBox client unavailable; warchest cannot persist trades.');
    return false;
  }

  try {
    await BootyBox.init();
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] BootyBox init failed; persistence disabled: ${msg}`);
    return false;
  }

  const missing = [];
  if (typeof BootyBox.recordScTradeEvent !== 'function') missing.push('recordScTradeEvent');
  if (typeof BootyBox.applyScTradeEventToPositions !== 'function')
    missing.push('applyScTradeEventToPositions');

  if (missing.length) {
    logger.error(
      `[HUD] BootyBox missing required helpers (${missing.join(', ')}); warchest persistence disabled.`
    );
    return false;
  }

  return true;
}

const WARCHEST_STATUS_DIR = path.join(process.cwd(), 'data', 'warchest');
const WARCHEST_STATUS_FILE = path.join(WARCHEST_STATUS_DIR, 'status.json');
const WARCHEST_PID_FILE = path.join(WARCHEST_STATUS_DIR, 'warchest.pid');

/**
 * Persist a lightweight health snapshot for other commands to read.
 * This is only used in daemon mode; HUD mode is ephemeral.
 *
 * @param {object} health
 */
function writeStatusSnapshot(health) {
  if (!health) return;

  try {
    if (!fs.existsSync(WARCHEST_STATUS_DIR)) {
      fs.mkdirSync(WARCHEST_STATUS_DIR, { recursive: true });
    }

    const snapshot = {
      updatedAt: new Date().toISOString(),
      health,
    };

    fs.writeFileSync(WARCHEST_STATUS_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to write warchest status snapshot: ${msg}`);
  }
}

function writePidFile() {
  try {
    if (!fs.existsSync(WARCHEST_STATUS_DIR)) {
      fs.mkdirSync(WARCHEST_STATUS_DIR, { recursive: true });
    }
    const payload = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(WARCHEST_PID_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to write warchest PID file: ${msg}`);
  }
}

function removePidFile() {
  try {
    if (fs.existsSync(WARCHEST_PID_FILE)) {
      fs.unlinkSync(WARCHEST_PID_FILE);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to remove warchest PID file: ${msg}`);
  }
}

// ---------- env helpers ----------
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HUD_SOL_REFRESH_SEC = intFromEnv('HUD_SOL_REFRESH_SEC', 15);
const HUD_TOKENS_REFRESH_SEC = intFromEnv('HUD_TOKENS_REFRESH_SEC', 30);

const TOKEN_PROGRAM_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const STABLE_MINTS = new Set([
  // USDC (Solana mainnet)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // USDT (Solana mainnet)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  // USD1 (World Liberty Financial USD1)
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
]);

// SOL wrapped mint for pricing (SolanaTracker Data API)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Last known SOL price in USD (shared across wallets for HUD header).
let lastSolPriceUsd = null;

// Simple rolling RPC/Data API timing stats for HUD display.
const rpcStats = {
  lastSolMs: null,
  lastTokenMs: null,
  lastDataApiMs: null,
};

// Shared SolanaTracker Data API client for token metadata lookups.
const dataClient = createSolanaTrackerDataClient();

// ---------- CLI arg parsing ----------
// For now we keep it dead simple and independent of commander:
//   --wallet alias:pubkey:color
//   --wallet sniper:AbCd...:magenta
//
// Later, warchest will launch this worker like:
//   node scripts/warchestService.js \
//     --wallet warlord:DDkF...:green \
//     --wallet sniper:ABCD...:magenta

function parseArgs(argv) {
  const wallets = [];
  const args = argv.slice(2);
  let mode = 'daemon'; // default: headless daemon mode

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--wallet') {
      const spec = args[i + 1];
      i += 1;
      if (!spec) continue;
      const [alias, pubkey, color] = spec.split(':');
      if (!alias || !pubkey) {
        logger.warn('[HUD] ignoring malformed --wallet spec:', spec);
        continue;
      }
      wallets.push({ alias, pubkey, color: color || null });
    } else if (arg === '-hud' || arg === '--hud') {
      mode = 'hud';
    }
  }

  return { wallets, mode };
}

// ---------- HUD state ----------

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
 * Build initial HUD state from CLI wallets.
 * In v1, tokens are just an empty list (to be filled later).
 * @param {{alias:string,pubkey:string,color:string|null}[]} walletSpecs
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

// Helper to push recent activity events for a wallet.
function pushRecentEvent(wallet, summary, hudStore) {
  if (!wallet.recentEvents) wallet.recentEvents = [];
  wallet.recentEvents.unshift({ ts: Date.now(), summary });
  if (wallet.recentEvents.length > 5) {
    wallet.recentEvents.length = 5;
  }
  if (hudStore) hudStore.emitChange();
}

// ---------- helpers for SOL balance refresh ----------

/**
 * Fetch the SOL balance for a single wallet via RPC methods helper.
 *
 * @param {*} rpcMethods
 * @param {string} pubkey
 * @returns {Promise<number|null>} balance in SOL or null on error
 */
async function fetchSolBalance(rpcMethods, pubkey) {
  if (!rpcMethods || typeof rpcMethods.getSolBalance !== 'function') return null;
  try {
    return await rpcMethods.getSolBalance(pubkey);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Failed to fetch SOL balance for ${pubkey} - ${msg}`);
    return null;
  }
}

/**
 * Refresh SOL balances for all wallets and update HUD state.
 * @param {*} rpcMethods
 * @param {Record<string,WalletState>} state
 * @param {{emitChange: Function}|null} hudStore
 */
async function refreshAllSolBalances(rpcMethods, state, hudStore) {
  const aliases = Object.keys(state);
  if (!rpcMethods || aliases.length === 0) return;

  const now = Date.now();
  const start = Date.now();

  await Promise.all(
    aliases.map(async (alias) => {
      const w = state[alias];
      const bal = await fetchSolBalance(rpcMethods, w.pubkey);
      if (bal == null) return;

      // Keep the shared walletState in sync (approximate lamports from SOL).
      const lamportsApprox = Math.round(bal * 1_000_000_000);
      updateSol(w.pubkey, lamportsApprox);

      if (w.startSolBalance == null) {
        w.startSolBalance = bal;
        w.solSessionDelta = 0;
      } else {
        w.solSessionDelta = bal - w.startSolBalance;
      }

      w.solBalance = bal;
      w.lastActivityTs = now;
    })
  );
  rpcStats.lastSolMs = Date.now() - start;
  if (hudStore) hudStore.emitChange();
}

/**
 * Refresh token balances for all wallets and update HUD state.
 *
 * @param {*} rpcMethods
 * @param {Record<string,WalletState>} state
 * @param {{emitChange: Function}|null} hudStore
 * @returns {Promise<void>}
 */
async function refreshAllTokenBalances(rpcMethods, state, hudStore) {
  const aliases = Object.keys(state);
  if (!rpcMethods || typeof rpcMethods.getTokenAccountsByOwnerV2 !== 'function' || aliases.length === 0) {
    return;
  }

  const now = Date.now();
  const tokenStart = Date.now();
  const tokenInfoCache = new Map(); // mint -> tokenInfo or null

  await Promise.all(
    aliases.map(async (alias) => {
      const wallet = state[alias];
      try {
        const allAccounts = [];

        const res22 = await fetchAllTokenAccounts(rpcMethods, wallet.pubkey, {
          programId: TOKEN_PROGRAM_22,
          limit: 500,
          excludeZero: true,
          pageLimit: 20,
        });
        const accounts22 = Array.isArray(res22?.accounts) ? res22.accounts : [];
        if (accounts22.length > 0) {
          wallet.hasToken22 = true;
          allAccounts.push(...accounts22);
        }
        if (res22?.truncated) {
          logger.warn(`[HUD] Token-22 pagination incomplete for ${wallet.alias}; balances may be partial.`);
        }

        const resLegacy = await fetchAllTokenAccounts(rpcMethods, wallet.pubkey, {
          programId: TOKEN_PROGRAM_LEGACY,
          limit: 500,
          excludeZero: true,
          pageLimit: 20,
        });
        const accountsLegacy = Array.isArray(resLegacy?.accounts) ? resLegacy.accounts : [];
        if (accountsLegacy.length > 0) {
          allAccounts.push(...accountsLegacy);
        }
        if (resLegacy?.truncated) {
          logger.warn(`[HUD] Legacy token pagination incomplete for ${wallet.alias}; balances may be partial.`);
        }

        const aggregated = new Map();
        for (const account of allAccounts) {
          const mint = account?.mint;
          if (!mint) continue;
          const amount =
            typeof account.uiAmount === 'number'
              ? account.uiAmount
              : Number(account.uiAmount);
          if (!Number.isFinite(amount)) continue;
          aggregated.set(mint, (aggregated.get(mint) || 0) + amount);
        }

        // Best-effort price lookup for all mints in this wallet using SolanaTracker Data API.
        const pricesByMint = {};
        const mints = Array.from(aggregated.keys());
        // Ensure SOL is always included so we can price the header, even if this wallet holds no SOL directly.
        if (!mints.includes(SOL_MINT)) {
          mints.push(SOL_MINT);
        }

        if (
          mints.length > 0 &&
          dataClient &&
          typeof dataClient.getMultipleTokenPrices === 'function'
        ) {
          try {
            // API expects an array of mints.
            const priceStart = Date.now();
            const resp = await dataClient.getMultipleTokenPrices({
              mints,
            });
            rpcStats.lastDataApiMs = Date.now() - priceStart;

            if (resp && typeof resp === 'object') {
              for (const [mintKey, info] of Object.entries(resp)) {
                if (!info || typeof info !== 'object') continue;
                const price = typeof info.price === 'number' ? info.price : null;
                if (price != null && Number.isFinite(price)) {
                  pricesByMint[mintKey] = price;
                }
              }

              // Update global SOL price if present.
              if (
                Object.prototype.hasOwnProperty.call(pricesByMint, SOL_MINT) &&
                typeof pricesByMint[SOL_MINT] === 'number'
              ) {
                lastSolPriceUsd = pricesByMint[SOL_MINT];
              }
            }
          } catch (priceErr) {
            const msg =
              priceErr && priceErr.message ? priceErr.message : priceErr;
            logger.error(
              `[HUD] Failed to fetch token prices for ${wallet.alias} ${wallet.pubkey} - ${msg}`
            );
          }
        }

        const tokenRows = [];
        for (const [mint, balance] of aggregated.entries()) {
          if (!(balance > 0)) continue;

          let baseline = wallet.startTokenBalances[mint];
          if (baseline == null) {
            baseline = balance;
            wallet.startTokenBalances[mint] = balance;
          }

          let tokenMeta = tokenInfoCache.get(mint);
          if (tokenMeta === undefined) {
            try {
              // Best-effort metadata fetch; tokenInfoService will handle DB/Data API details.
              tokenMeta = await ensureTokenInfo({ mint, client: dataClient });
            } catch (metaErr) {
              const msg =
                metaErr && metaErr.message ? metaErr.message : metaErr;
              logger.error(
                `[HUD] Failed to ensure token info for mint ${mint} - ${msg}`
              );
              tokenMeta = null;
            }
            tokenInfoCache.set(mint, tokenMeta);
          }

          let symbol = '';
          let decimals = null;

          if (tokenMeta) {
            // Handle both API shape ({ token: {...} }) and DB row shape ({ symbol, decimals, ... }).
            const tokenLike = tokenMeta.token || tokenMeta;

            if (tokenLike.symbol) {
              symbol = String(tokenLike.symbol);
            } else if (tokenLike.name) {
              // Fallback: show truncated name instead of blank.
              symbol = String(tokenLike.name).slice(0, 6);
            }

            if (typeof tokenLike.decimals === 'number') {
              decimals = tokenLike.decimals;
            }
          }

          // Optional debug: see what we're getting if symbol is still empty
          if (!symbol && tokenMeta && process.env.HUD_DEBUG_METADATA === '1') {
            // eslint-disable-next-line no-console
            logger.debug('[HUD] tokenMeta had no symbol', { mint, tokenMeta });
          }

          const priceUsd = pricesByMint[mint];
          const usdEstimate =
            priceUsd != null && Number.isFinite(priceUsd)
              ? priceUsd * balance
              : null;

          tokenRows.push({
            symbol,
            mint,
            balance,
            sessionDelta: balance - baseline,
            usdEstimate,
            decimals,
          });
        }

        wallet.tokens = tokenRows;
        wallet.lastActivityTs = now;
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.error(`[HUD] Failed to fetch tokens for ${wallet.alias} ${wallet.pubkey} - ${msg}`);
      }
    })
  );
  rpcStats.lastTokenMs = Date.now() - tokenStart;
  if (hudStore) hudStore.emitChange();
}

// ---------- main loop ----------

async function main() {
  const { wallets, mode } = parseArgs(process.argv);

  if (!wallets || wallets.length === 0) {
    logger.error('[HUD] No wallets provided. Use --wallet alias:pubkey:color');
    process.exit(1);
  }

  const bootyReady = await ensureBootyBoxReady();
  if (!bootyReady) {
    logger.error('[HUD] Exiting because BootyBox is unavailable for persistence.');
    process.exit(1);
  }

  const resolvedWallets = await resolveWalletSpecsWithRegistry(wallets, BootyBox);
  if (!resolvedWallets.length) {
    logger.error('[HUD] Exiting because no wallets could be resolved against sc_wallets.');
    process.exit(1);
  }

  if (resolvedWallets.length !== wallets.length) {
    logger.warn(
      `[HUD] Resolved ${resolvedWallets.length}/${wallets.length} wallets; unresolved entries will not be persisted.`,
    );
  }

  logger.info(`[HUD] Starting warchest HUD worker in ${mode} mode.`);

  const state = buildInitialState(resolvedWallets);
  const hudStore = createHudStore(() => ({
    state,
    lastSolPriceUsd,
    rpcStats: { ...rpcStats },
  }));
  writePidFile();

  // Create SolanaTracker RPC client (HTTP + WS).
  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
  const rpcMethods = createRpcMethods(rpc, rpcSubs);

  // WalletManagerV2 instances per wallet alias. These are responsible for
  // turning log notifications into trade events and position updates.
  const walletManagers = {};

  resolvedWallets.forEach((w) => {
    if (w.walletId == null) {
      logger.warn(`[HUD] Skipping WalletManagerV2 for ${w.alias}; walletId not resolved.`);
      return;
    }
    try {
      walletManagers[w.alias] = new WalletManagerV2({
        rpc,
        walletId: w.walletId,
        walletAlias: w.alias,
        walletPubkey: w.pubkey,
        txInsightService,
        // tokenPriceService is optional; HUD already has a global SOL price
        // via lastSolPriceUsd and token price pulls, so we can omit it here
        // for now and add it later if needed.
        tokenPriceService: null,
        bootyBox: BootyBox,
        // Strategy / WarlordAI decision context provider is optional and
        // will be wired in once that layer is ready.
        strategyContextProvider: null,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(
        `[HUD] Failed to initialize WalletManagerV2 for ${w.alias} (${w.pubkey}): ${msg}`,
      );
    }
  });

  let slotSub = null;
  const accountSubs = [];
  const logsSubs = [];
  // Recent activity via logsSubscribe (best-effort, may not be supported on all endpoints).
  if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeLogs === 'function') {
    const aliasesForLogs = Object.keys(state);

    for (const alias of aliasesForLogs) {
      const wallet = state[alias];
      try {
        logger.info(`[HUD] Subscribing to logs for ${wallet.alias} (${wallet.pubkey}).`);
        const sub = await rpcMethods.subscribeLogs(
          { mentions: [wallet.pubkey] },
          (ev) => {
            try {
              const value = ev && (ev.value || ev.result || ev);
              if (!value) return;

              const logs = Array.isArray(value.logs) ? value.logs : [];
              const signature = typeof value.signature === 'string' ? value.signature : null;
              const firstLog = logs[0] || '';
              const shortSig = signature
                ? `${signature.slice(0, 4)}...${signature.slice(-4)}`
                : 'unknown sig';
              const msg = firstLog ? firstLog.slice(0, 60) : 'log event';
              const summary = `${new Date().toLocaleTimeString()} ${shortSig} ${msg}`;
              pushRecentEvent(wallet, summary, hudStore);

              // Forward the raw log notification to WalletManagerV2 so it can
              // derive trade events and position updates. This is best-effort
              // and should never crash the HUD loop.
              const wm = walletManagers[alias];
              if (wm && typeof wm.handleLogNotification === 'function') {
                Promise.resolve(wm.handleLogNotification(ev)).catch((wmErr) => {
                  const wmsg = wmErr && wmErr.message ? wmErr.message : wmErr;
                  logger.warn(
                    `[HUD] WalletManagerV2 error for ${wallet.alias}: ${wmsg}`,
                  );
                });
              }
            } catch (logErr) {
              const msg = logErr && logErr.message ? logErr.message : logErr;
              logger.warn(`[HUD] Error processing logs event for ${wallet.alias}: ${msg}`);
            }
          }
        );

        logsSubs.push(sub);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to subscribe to logs for ${wallet.alias} (${wallet.pubkey}): ${msg}`);
      }
    }
  } else if (!rpcSubs) {
    logger.warn('[HUD] Logs subscriptions skipped: rpcSubs not available.');
  } else {
    logger.warn('[HUD] Logs subscriptions skipped: rpcMethods.subscribeLogs is not available.');
  }

  // WebSocket RPC is used for a chain heartbeat (slotSubscribe) and, where
  // available, live SOL balance updates via accountSubscribe. Tokens remain
  // on HTTP polling for now.
  logger.info('[HUD] SolanaTracker RPC client initialized.');
  if (!rpcSubs) {
    // eslint-disable-next-line no-console
    logger.warn('[HUD] rpcSubs is null; WS subscriptions are disabled (no SOLANATRACKER_RPC_WS_URL?).');
  }

  if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeSlot === 'function') {
    try {
      logger.info('[HUD] Subscribing to slot updates for chain heartbeat.');
      slotSub = await rpcMethods.subscribeSlot((ev) => {
        updateFromSlotEvent(ev);
        hudStore.emitChange();
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.error(`[HUD] Failed to subscribe to slot updates: ${msg}`);
    }
  } else if (!rpcSubs) {
    logger.warn('[HUD] Slot subscription skipped: rpcSubs not available.');
  } else {
    logger.warn('[HUD] Slot subscription skipped: rpcMethods.subscribeSlot is not available.');
  }

  // Live SOL balance updates via accountSubscribe (best-effort).
  if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeAccount === 'function') {
    const aliases = Object.keys(state);

    for (const alias of aliases) {
      const wallet = state[alias];
      try {
        logger.info(`[HUD] Subscribing to SOL account for ${wallet.alias} (${wallet.pubkey}).`);

        const sub = await rpcMethods.subscribeAccount(wallet.pubkey, (ev) => {
          try {
            const value = ev && (ev.value || ev.account || ev);
            if (!value) return;

            let lamports = null;
            if (typeof value.lamports === 'number') {
              lamports = value.lamports;
            } else if (value.lamports != null) {
              lamports = Number(value.lamports);
            }

            if (!Number.isFinite(lamports)) return;

            // Update shared wallet state (lamports) so any consumer can see live SOL.
            updateSol(wallet.pubkey, lamports);

            const now = Date.now();
            const sol = lamports / 1_000_000_000;

            if (wallet.startSolBalance == null) {
              wallet.startSolBalance = sol;
              wallet.solSessionDelta = 0;
            } else {
              wallet.solSessionDelta = sol - wallet.startSolBalance;
            }

            wallet.solBalance = sol;
            wallet.lastActivityTs = now;

            hudStore.emitChange();
          } catch (updateErr) {
            const msg = updateErr && updateErr.message ? updateErr.message : updateErr;
            logger.warn(`[HUD] Error processing SOL account update for ${wallet.alias}: ${msg}`);
          }
        });

        accountSubs.push(sub);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to subscribe to SOL account for ${wallet.alias} (${wallet.pubkey}): ${msg}`);
      }
    }
  } else if (!rpcSubs) {
    logger.warn('[HUD] SOL account subscriptions skipped: rpcSubs not available.');
  } else {
    logger.warn('[HUD] SOL account subscriptions skipped: rpcMethods.subscribeAccount is not available.');
  }

  // Initial SOL balance fetch
  await refreshAllSolBalances(rpcMethods, state, hudStore);
  await refreshAllTokenBalances(rpcMethods, state, hudStore);

  // Periodic SOL refresh using HTTP RPC
  const solTimer = setInterval(() => {
    refreshAllSolBalances(rpcMethods, state, hudStore).catch((err) => {
      logger.error('[HUD] Error refreshing SOL balances:', err.message || err);
    });
  }, HUD_SOL_REFRESH_SEC * 1000);

  const tokenTimer = setInterval(() => {
    refreshAllTokenBalances(rpcMethods, state, hudStore).catch((err) => {
      logger.error('[HUD] Error refreshing token balances:', err.message || err);
    });
  }, HUD_TOKENS_REFRESH_SEC * 1000);

  const healthTimer = setInterval(() => {
    const health = updateHealth(state, rpcStats);
    if (mode === 'daemon' && health && health.process && health.ws && health.wallets) {
      const rssMb = Math.round(health.process.rssBytes / 1024 / 1024);
      const lagMs = health.process.eventLoopLagMs;

      // Persist a snapshot for other commands to inspect.
      writeStatusSnapshot(health);

      logger.info(
        `[warchest] Health: up=${health.process.uptimeSec}s rss=${rssMb}MB slot=${health.ws.slot} wsAge=${health.ws.lastSlotAgeMs}ms lag=${lagMs}ms wallets=${health.wallets.count}`
      );
    }
  }, 5000);

  // Render loop (only in HUD mode)
  let inkApp = null;
  if (mode === 'hud') {
    const ink = await loadInkModule();
    const { render } = ink;
    const WarchestApp = createWarchestApp(ink);
    inkApp = render(
      React.createElement(WarchestApp, {
        hudStore,
        stableMints: STABLE_MINTS,
      })
    );
  }

  // Graceful shutdown
  function shutdown() {
    clearInterval(solTimer);
    clearInterval(tokenTimer);
    clearInterval(healthTimer);
    if (inkApp && typeof inkApp.unmount === 'function') {
      inkApp.unmount();
    }
    hudStore.removeAllListeners();
    Promise.resolve()
      .then(async () => {
        try {
          if (slotSub && typeof slotSub.unsubscribe === 'function') {
            await slotSub.unsubscribe();
          }
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Error during slot subscription unsubscribe: ${msg}`);
        }

        try {
          for (const sub of accountSubs) {
            if (sub && typeof sub.unsubscribe === 'function') {
              await sub.unsubscribe();
            }
          }
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Error during SOL account subscriptions unsubscribe: ${msg}`);
        }

        try {
          for (const sub of logsSubs) {
            if (sub && typeof sub.unsubscribe === 'function') {
              await sub.unsubscribe();
            }
          }
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Error during logs subscriptions unsubscribe: ${msg}`);
        }

        return close();
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Error during RPC client close: ${msg}`);
      })
      .finally(() => {
        removePidFile();
        process.exit(0);
      });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run if invoked directly
if (require.main === module) {
  main().catch((err) => {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Fatal error: ${msg}`);
    removePidFile();
    process.exit(1);
  });
}
