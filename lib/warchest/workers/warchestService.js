#!/usr/bin/env node
'use strict';

// lib/warchest/workers/warchestService.js
// Long-running HUD worker: given wallet info via CLI args,
// connect to SolanaTracker RPC, maintain simple state, and render a
// multi-wallet dashboard in the terminal.


require('../../env/safeDotenv').loadDotenv();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const React = require('react');

const { createSolanaTrackerRPCClient } = require('../../solanaTrackerRPCClient');
const { createRpcMethods } = require('../../solana/rpcMethods');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
const { ensureTokenInfo, upsertTokenInfoPayload } = require('../../services/tokenInfoService');
const { createHubEventFollower } = require('../events');
const logger = require('../../logger');
const { updateFromSlotEvent, getChainState } = require('../../solana/rpcMethods/internal/chainState');
const { updateSol } = require('../../solana/rpcMethods/internal/walletState');
const { createWarchestApp } = require('../../hud/warchestInkApp');
const { createHudStore } = require('../../hud/hudStore');
const { updateHealth } = require('../health');
const { fetchAllTokenAccounts } = require('../fetchAllTokenAccounts');
const { createWsSupervisor } = require('../wsSupervisor');
const { resolveWalletSpecsWithRegistry } = require('../../wallets/resolver');
const { closeLingeringSession } = require('./sessionLifecycle');
const { STABLE_MINTS, isStableMint } = require('../../solana/stableMints');
const { forkWorkerWithPayload } = require('./harness');

const SESSION_SERVICE_NAME = 'warchest-service';
const SERVICE_INSTANCE_ID = crypto.randomUUID();
let sessionFinalizer = null;

const WalletManagerV2 = require('../../WalletManagerV2');
const txInsightService = require('../../services/txInsightService');

// Current RPC socket registry (populated by createSolanaTrackerRPCClient) for metrics/cleanup.
let rpcSocketRegistry = null;
let eventFollower = null;

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
  // BootyBox index should select the SQLite adapter.
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
 * This guards against silent failures when the adapter is missing or the
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
  // recordScTradeEvent is the single-writer entry point and is responsible for keeping sc_positions in sync.
  if (typeof BootyBox.recordScTradeEvent !== 'function') missing.push('recordScTradeEvent');
  if (typeof BootyBox.startSession !== 'function') missing.push('startSession');
  if (typeof BootyBox.endSession !== 'function') missing.push('endSession');
  if (typeof BootyBox.updateSessionStats !== 'function') missing.push('updateSessionStats');
  if (typeof BootyBox.getPnlPositionsLive !== 'function') missing.push('getPnlPositionsLive');

  if (missing.length) {
    logger.error(
      `[HUD] BootyBox missing required helpers (${missing.join(', ')}); warchest persistence disabled.`
    );
    return false;
  }

  // Optional helpers: used by discovery/resync flows; warn but do not disable persistence.
  if (typeof BootyBox.ensureOpenPositionRun !== 'function') {
    logger.warn(
      '[HUD] BootyBox.ensureOpenPositionRun is not available; external/discovery holdings may not get a position-run trade_uuid until the first in-app trade.'
    );
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ink renders to stdout. Any other writes to stdout (winston/console/BootyBox logs)
 * will visibly "stutter" the HUD and can interfere with keyboard input.
 *
 * In HUD mode, we try to keep stdout exclusively for Ink by routing likely log
 * lines to stderr.
 *
 * This is intentionally conservative: we only redirect chunks that look like
 * plaintext log lines (timestamps / bracketed logger prefixes).
 */
function installHudStdoutGuard() {
  const origWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);

  // Common log prefixes we see in Scoundrel and BootyBox.
  const looksLikeLogLine = (s) => {
    if (!s) return false;

    // Ignore Ink/ANSI-heavy frames.
    if (s.includes('\u001b[')) return false;

    const trimmed = s.trimStart();

    // Winston-style: "2025-12-24 11:56:16 info: ..."
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+/.test(trimmed)) return true;

    // Bracketed: "[2025-12-24T..] [BootyBox] info: ..."
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) return true;

    // Explicit tags we commonly emit
    if (trimmed.startsWith('[HUD]') || trimmed.startsWith('[warchest]') || trimmed.startsWith('[KitRPC]')) return true;

    return false;
  };

  // eslint-disable-next-line no-param-reassign
  process.stdout.write = (chunk, encoding, cb) => {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk?.toString?.(encoding || 'utf8');
      if (typeof s === 'string' && looksLikeLogLine(s)) {
        errWrite(s, encoding);
        if (typeof cb === 'function') cb();
        return true;
      }
    } catch {
      // fall through to original
    }

    return origWrite(chunk, encoding, cb);
  };

  return () => {
    // eslint-disable-next-line no-param-reassign
    process.stdout.write = origWrite;
  };
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
const HUD_MAX_TX = intFromEnv('WARCHEST_HUD_MAX_TX', 10);
const HUD_MAX_LOGS = intFromEnv('WARCHEST_HUD_MAX_LOGS', 5);
const WARCHEST_HUD_EMIT_THROTTLE_MS = intFromEnv('WARCHEST_HUD_EMIT_THROTTLE_MS', 100);
const WARCHEST_LOG_REFRESH_DEBOUNCE_MS = intFromEnv('WARCHEST_LOG_REFRESH_DEBOUNCE_MS', 750);
const WARCHEST_WS_STALE_MS = intFromEnv('WARCHEST_WS_STALE_MS', 20_000);
const WARCHEST_WS_RESTART_GAP_MS = intFromEnv('WARCHEST_WS_RESTART_GAP_MS', 30_000);
const WARCHEST_WS_RESTART_MAX_BACKOFF_MS = intFromEnv('WARCHEST_WS_RESTART_MAX_BACKOFF_MS', 5 * 60_000);
const WARCHEST_WS_UNSUB_TIMEOUT_MS = intFromEnv('WARCHEST_WS_UNSUB_TIMEOUT_MS', 2500);

const TOKEN_PROGRAM_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';


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
const dataClient = createSolanaTrackerDataClient({
  logger: logger.solanaTrackerData(),
});

// Cache for coin metadata keyed by mint (populated via tokenInfoService.ensureTokenInfo).
const coinCache = new Map();
const COIN_CACHE_MAX_AGE_MS = 60_000;

// Toggle set by the token refresh timer: when true, we do an expensive full-meta refresh.
// When false, we do a cheap batch price refresh.
let hudMetaRefreshTick = false;

// Live transaction feed for HUD (trimmed to HUD_MAX_TX).
// Keep a stable per-tx cache so the HUD doesn't flicker/reorder when metadata is enriched.
const txFeed = [];
const txFeedById = new Map(); // txid -> entry

// Small helper to cap/trim a HUD-visible alert list.
function pushServiceAlert(alerts, level, message, meta) {
  if (!Array.isArray(alerts)) return;
  alerts.unshift({
    ts: Date.now(),
    level: level || 'info',
    message: String(message || ''),
    meta: meta || null,
  });
  if (alerts.length > 8) alerts.length = 8;
}

async function withTimeout(promise, ms, label) {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
  if (!timeoutMs) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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

// ---------- SellOps state (streamed from sellOpsWorker children) ----------
const sellOpsState = {
  byWallet: {}, // alias -> { heartbeat, evalByMint, autopsies }
};

// Keep last displayed SellOps intel per wallet+mint to avoid spamming recentEvents.
// We track recommendation + qualify summary (not execution decision) because decision stays "hold" in observe mode.
const sellOpsLastDisplayed = new Map(); // key `${alias}:${mint}` -> { recommendation, worstSeverity, failedCount, ts }

// Keep last heartbeat alert per wallet alias so we can confirm SellOps is alive without spamming alerts.
const sellOpsLastHeartbeatAlert = new Map(); // alias -> ts

function upsertSellOpsHeartbeat(alias, hb) {
  if (!alias) return;
  if (!sellOpsState.byWallet[alias]) {
    sellOpsState.byWallet[alias] = { heartbeat: null, evalByMint: {}, autopsies: [] };
  }
  sellOpsState.byWallet[alias].heartbeat = hb || null;
}

function upsertSellOpsEvaluation(alias, mint, payload) {
  if (!alias || !mint) return;
  if (!sellOpsState.byWallet[alias]) {
    sellOpsState.byWallet[alias] = { heartbeat: null, evalByMint: {}, autopsies: [] };
  }
  sellOpsState.byWallet[alias].evalByMint[mint] = payload;
}

function pushSellOpsAutopsy(alias, payload) {
  if (!alias || !payload) return;
  if (!sellOpsState.byWallet[alias]) {
    sellOpsState.byWallet[alias] = { heartbeat: null, evalByMint: {}, autopsies: [] };
  }
  const list = sellOpsState.byWallet[alias].autopsies || [];
  list.unshift(payload);
  const maxEntries = Math.max(1, HUD_MAX_LOGS || 25);
  if (list.length > maxEntries) list.length = maxEntries;
  sellOpsState.byWallet[alias].autopsies = list;
}

function shouldDisplaySellOpsEvent(alias, mint, intel) {
  const key = `${alias}:${mint}`;
  const now = Date.now();

  const recommendation = intel?.recommendation || 'hold';
  const worstSeverity = intel?.worstSeverity || 'none';
  const failedCount = Number.isFinite(Number(intel?.failedCount)) ? Number(intel.failedCount) : 0;

  const prev = sellOpsLastDisplayed.get(key) || null;

  // Always emit the first time we see this mint.
  if (!prev) {
    sellOpsLastDisplayed.set(key, { recommendation, worstSeverity, failedCount, ts: now });
    return true;
  }

  // Emit if the recommendation or qualify state changed.
  if (
    prev.recommendation !== recommendation ||
    prev.worstSeverity !== worstSeverity ||
    prev.failedCount !== failedCount
  ) {
    sellOpsLastDisplayed.set(key, { recommendation, worstSeverity, failedCount, ts: now });
    return true;
  }

  // Otherwise suppress spam.
  return false;
}

// ---------- HUD state ----------
async function ingestTxEvents(events, hudStore) {
  if (!Array.isArray(events) || events.length === 0) return;

  // Helper: stable timestamp extraction for sorting.
  const tsOf = (ev) => {
    if (!ev) return 0;

    // Prefer true chain time if present.
    const ts =
      ev.txSummary?.blockTimeIso ||
      ev.blockTimeIso ||
      ev.txSummary?.observedAt ||
      ev.observedAt ||
      null;

    const ms = ts ? Date.parse(ts) : null;
    return Number.isFinite(ms) ? ms : 0;
  };

  // Helper: filter out obvious dust/spam txs.
  const isDustTx = (entry) => {
    if (!entry) return true;

    // If we have neither mint nor side nor any amounts, it's not useful.
    const hasAmounts =
      (entry.sol != null && Number.isFinite(Number(entry.sol)) && Math.abs(Number(entry.sol)) > 0) ||
      (entry.tokens != null && Number.isFinite(Number(entry.tokens)) && Math.abs(Number(entry.tokens)) > 0);

    if (!entry.mint && !entry.side && !hasAmounts) return true;

    // Tiny SOL transfers (common spam / dust / micro staking)
    if (!entry.side && entry.sol != null && Number.isFinite(Number(entry.sol)) && Math.abs(Number(entry.sol)) < 0.00001) {
      return true;
    }

    // Tiny token movements with no SOL leg
    if (!entry.side && entry.tokens != null && Number.isFinite(Number(entry.tokens)) && Math.abs(Number(entry.tokens)) < 0.0001) {
      return true;
    }

    return false;
  };

  const max = HUD_MAX_TX;

  // Normalize ordering: newest-first, stable.
  const recent = (events || [])
    .slice(0)
    .sort((a, b) => {
      const at = tsOf(a);
      const bt = tsOf(b);
      if (bt !== at) return bt - at;

      const aid = (a && (a.txid || a.txSummary?.txid)) || '';
      const bid = (b && (b.txid || b.txSummary?.txid)) || '';
      // Desc string compare for stability
      return bid.localeCompare(aid);
    })
    .slice(0, max);

  const nextFeed = [];

  for (const ev of recent) {
    const txid = (ev && (ev.txid || ev.txSummary?.txid)) || null;
    if (!txid) continue;

    const prev = txFeedById.get(txid) || null;
    const entry = buildTxDisplay(ev, prev);
    if (!entry) continue;

    // Filter spam/dust so the TX panel is readable.
    if (isDustTx(entry)) continue;

    // Ensure a stable observedAt for sorting. Never promote unknown historical events to "now".
    if (!Number.isFinite(Number(entry.observedAt)) || Number(entry.observedAt) <= 0) {
      entry.observedAt = prev?.observedAt ?? tsOf(ev) ?? 0;
    }

    // Preserve previously enriched coin metadata to avoid flicker.
    if (prev && prev.coin && !entry.coin) {
      entry.coin = prev.coin;
    }

    txFeedById.set(txid, entry);
    nextFeed.push(entry);
  }

  // Replace the visible feed in one shot.
  txFeed.length = 0;
  for (const entry of nextFeed) txFeed.push(entry);

  // Best-effort async enrichment: do not block the HUD on token metadata.
  for (const entry of nextFeed) {
    if (!entry || !entry.mint || entry.coin) continue;
    fetchCoinMeta(entry.mint)
      .then((info) => {
        const mapped = mapCoinMeta(info);
        if (!mapped) return;
        const current = txFeedById.get(entry.txid);
        if (!current) return;
        // Only set if still missing to avoid thrashing.
        if (!current.coin) {
          current.coin = mapped;
          if (hudStore) hudStore.emitChange();
        }
      })
      .catch(() => {
        // ignore enrichment errors
      });
  }

  if (hudStore) hudStore.emitChange();
}

/**
 * @typedef {Object} TokenRow
 * @property {string} symbol
 * @property {string} mint
 * @property {number} balance
 * @property {number} sessionDelta
 * @property {number|null} usdEstimate
 * @property {number|null} decimals
 * @property {number|null} priceUsd
 * @property {{'1m'?:number,'5m'?:number,'15m'?:number,'30m'?:number}|null} changePct
 * @property {number|null} liquidityUsd
 * @property {number|null} marketCapUsd
 * @property {number|null} curvePct
 * @property {number|null} riskScore
 * @property {number|null} top10Pct
 * @property {number|null} sniperPct
 * @property {number|null} devPct
 * @property {string[]|null} riskTags
 * @property {{ts:number,recommendation:string,strategyName:string|null,qualifyWorst:string,qualifyFailed:number,regime:string|null,gateFail:string|null}|null} sellOps
 * @property {string|null} sellOpsLine
 * @property {{entryUsd:number|null,currentUsd:number|null,unrealizedPnlUsd:number|null,realizedPnlUsd:number|null,roiPct:number|null,avgEntryUsd:number|null,avgEntryPriceUsd:number|null}|null} position
 * @property {string|null} positionLine
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
 * @property {Object<string, object>} pnlByMint
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
      pnlByMint: {},
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
  if (wallet.recentEvents.length > HUD_MAX_LOGS) {
    wallet.recentEvents.length = HUD_MAX_LOGS;
  }
  if (hudStore) hudStore.emitChange();
}

async function fetchCoinMeta(mint) {
  if (!mint) return null;
  const cached = coinCache.get(mint);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < COIN_CACHE_MAX_AGE_MS) {
    return cached.data;
  }

  try {
    const info = await ensureTokenInfo({ mint, client: dataClient, forceRefresh: hudMetaRefreshTick });
    if (info) {
      coinCache.set(mint, { data: info, fetchedAt: now });
      return info;
    }
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] token info fetch failed for ${mint}: ${msg}`);
  }
  return cached ? cached.data : null;
}

function extractPriceChange(eventsObj) {
  if (!eventsObj || typeof eventsObj !== 'object') return null;
  const slices = ['1m', '5m', '15m', '30m'];
  const res = {};
  for (const key of slices) {
    const delta =
      eventsObj[key] && Number.isFinite(Number(eventsObj[key].priceChangePercentage))
        ? Number(eventsObj[key].priceChangePercentage)
        : null;
    if (delta != null) res[key] = delta;
  }
  return Object.keys(res).length ? res : null;
}

function mapCoinMeta(info) {
  if (!info || typeof info !== 'object') return null;
  const token = info.token || {};
  const pools = Array.isArray(info.pools) ? info.pools : [];
  const primaryPool = pools[0] || null;
  const price =
    (primaryPool && primaryPool.price && Number(primaryPool.price.usd)) ||
    (primaryPool && primaryPool.price && Number(primaryPool.price.quote)) ||
    null;
  const events = info.events || null;
  const priceChanges = extractPriceChange(events);
  const holders = Array.isArray(info.holders) ? info.holders.length : null;

  return {
    mint: token.mint || null,
    name: token.name || token.symbol || null,
    symbol: token.symbol || null,
    priceUsd: Number.isFinite(price) ? price : null,
    events: priceChanges,
    holders,
    lastUpdated: primaryPool && primaryPool.lastUpdated ? Number(primaryPool.lastUpdated) : null,
  };
}

function pickPrimaryPool(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return null;

  let best = null;
  let bestUsd = -1;

  for (const p of pools) {
    const usd =
      p && p.liquidity && Number.isFinite(Number(p.liquidity.usd))
        ? Number(p.liquidity.usd)
        : Number.isFinite(Number(p && p.liquidityUsd))
          ? Number(p.liquidityUsd)
          : Number.isFinite(Number(p && p.liquidity))
            ? Number(p.liquidity)
            : 0;

    if (usd > bestUsd) {
      bestUsd = usd;
      best = p;
    }
  }

  return best || pools[0] || null;
}

function extractCurvePct(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return null;

  // Pumpfun pool rows include curvePercentage on the pool object.
  for (const p of pools) {
    if (!p || typeof p !== 'object') continue;
    const v = p.curvePercentage;
    if (Number.isFinite(Number(v))) return Number(v);
  }

  return null;
}

function extractRiskFields(tokenMetaRow) {
  const risk = tokenMetaRow && tokenMetaRow.risk ? tokenMetaRow.risk : null;
  if (!risk || typeof risk !== 'object') {
    return {
      riskScore: null,
      top10Pct: null,
      sniperPct: null,
      devPct: null,
      riskTags: null,
    };
  }

  const riskScore = Number.isFinite(Number(risk.score)) ? Number(risk.score) : null;
  const top10Pct = Number.isFinite(Number(risk.top10)) ? Number(risk.top10) : null;

  const sniperPct =
    risk.snipers && Number.isFinite(Number(risk.snipers.totalPercentage))
      ? Number(risk.snipers.totalPercentage)
      : null;

  const devPct =
    risk.dev && Number.isFinite(Number(risk.dev.percentage))
      ? Number(risk.dev.percentage)
      : null;

  const tagsRaw = Array.isArray(risk.risks) ? risk.risks : [];
  const riskTags = tagsRaw
    .map((r) => (r && r.name ? String(r.name) : null))
    .filter((s) => typeof s === 'string' && s.length > 0);

  return {
    riskScore,
    top10Pct,
    sniperPct,
    devPct,
    riskTags: riskTags.length ? riskTags : null,
  };
}

function deriveStatusCategory(event) {
  if (!event) return 'unknown';
  if (event.statusCategory) return String(event.statusCategory);

  const txSummary = event.txSummary || null;
  if (txSummary && txSummary.statusCategory) return String(txSummary.statusCategory);

  const status = event.status || txSummary?.status || 'unknown';
  if (status === 'confirmed' || status === 'ok') return 'confirmed';
  if (status === 'failed') return 'failed';
  return 'processed';
}

function deriveStatusEmoji(cat) {
  if (cat === 'confirmed') return '🟢';
  if (cat === 'failed') return '🔴';
  return '🟡';
}

function buildTxDisplay(event, prev) {
  if (!event || typeof event !== 'object') return null;

  const txSummary = event.txSummary || {};
  const statusCategory = deriveStatusCategory(event);
  const statusEmoji =
    event.statusEmoji || txSummary.statusEmoji || prev?.statusEmoji || deriveStatusEmoji(statusCategory);

  const side = txSummary.side || (event.context && event.context.side) || null;
  const mint = txSummary.mint || (event.context && event.context.mint) || prev?.mint || null;
  const wallet = (event.context && event.context.wallet) || prev?.wallet || null;

  const slot =
    txSummary.slot != null
      ? txSummary.slot
      : event.slot != null
        ? event.slot
        : prev?.slot != null
          ? prev.slot
          : null;

  // Keep a stable observedAt so rows don't "jump" when we re-render.
  const observedAtParsed =
    (txSummary.blockTimeIso ? Date.parse(txSummary.blockTimeIso) : null) ??
    (txSummary.observedAt ? Date.parse(txSummary.observedAt) : null) ??
    (event.observedAt ? Date.parse(event.observedAt) : null);

  // IMPORTANT: do NOT fall back to Date.now() here. If the event has no timestamp
  // (common when reading a persisted feed on restart), using "now" will reorder
  // history and make timestamps appear inconsistent.
  const observedAt =
    (Number.isFinite(observedAtParsed) ? observedAtParsed : null) ??
    (Number.isFinite(prev?.observedAt) ? prev.observedAt : 0);

  const blockTimeIso = txSummary.blockTimeIso || prev?.blockTimeIso || null;
  const tokens = txSummary.tokens != null ? txSummary.tokens : prev?.tokens ?? null;
  const sol = txSummary.sol != null ? txSummary.sol : prev?.sol ?? null;
  const priceImpactPct = txSummary.priceImpactPct != null ? txSummary.priceImpactPct : prev?.priceImpactPct ?? null;
  const totalFeesSol = txSummary.totalFeesSol != null ? txSummary.totalFeesSol : prev?.totalFeesSol ?? null;
  const explorerUrl = txSummary.explorerUrl || prev?.explorerUrl || null;

  return {
    txid: event.txid || txSummary.txid || prev?.txid || null,
    statusCategory,
    statusEmoji,
    side,
    mint,
    wallet,
    slot,
    observedAt,
    blockTimeIso,
    tokens,
    sol,
    priceImpactPct,
    totalFeesSol,
    explorerUrl,
    label: txSummary.label || prev?.label || null,
    errMessage:
      txSummary.errMessage ||
      prev?.errMessage ||
      (event.err && (event.err.message || JSON.stringify(event.err))) ||
      null,
    symbol: txSummary.symbol || prev?.symbol || null,
    coin: prev?.coin || null,
  };
}

function createThrottledEmitter(emitFn, throttleMs) {
  const ms = Number.isFinite(Number(throttleMs)) && Number(throttleMs) > 0 ? Math.trunc(Number(throttleMs)) : 0;
  if (!ms) {
    return () => {
      try { emitFn(); } catch {}
    };
  }

  let last = 0;
  let scheduled = false;

  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      try { emitFn(); } catch {}
      return;
    }
    if (scheduled) return;
    scheduled = true;

    setTimeout(() => {
      scheduled = false;
      last = Date.now();
      try { emitFn(); } catch {}
    }, ms);
  };
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
 * Refresh token balances for a single wallet and update HUD state.
 *
 * @param {*} rpcMethods
 * @param {WalletState} wallet
 * @param {object} [opts] - options, e.g. { mode: 'meta' | 'price' }
 * @returns {Promise<void>}
 */
async function refreshTokenBalancesForWallet(rpcMethods, wallet, opts = {}) {
  if (!rpcMethods || !wallet || typeof rpcMethods.getTokenAccountsByOwnerV2 !== 'function') {
    return;
  }

  const mode = opts && opts.mode === 'meta' ? 'meta' : 'price';
  const doMeta = mode === 'meta';

  const now = Date.now();

  try {
    const allAccounts = [];

    // Preserve prior per-mint display fields so PRICE ticks don't lose symbols/decimals/usdEstimate.
    const prevByMint = new Map();
    if (Array.isArray(wallet.tokens)) {
      for (const row of wallet.tokens) {
        if (row && row.mint) prevByMint.set(row.mint, row);
      }
    }

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

    // META ticks: fetch wallet token metadata in one call (instead of per-mint ensureTokenInfo).
    // This payload mirrors the single-token contract but is wrapped in { tokens: [...] }.
    const walletTokenMetaByMint = new Map();
    if (doMeta && dataClient && typeof dataClient.getWalletTokens === 'function') {
      try {
        const metaStart = Date.now();
        const walletMetaResp = await dataClient.getWalletTokens({ wallet: wallet.pubkey });
        rpcStats.lastDataApiMs = Date.now() - metaStart;

        const rows = walletMetaResp && Array.isArray(walletMetaResp.tokens) ? walletMetaResp.tokens : [];
        for (const row of rows) {
          const mint = row?.token?.mint || row?.token?.address || row?.mint || null;
          if (!mint) continue;
          walletTokenMetaByMint.set(mint, row);
        }

        // Persist coin metadata/stats into BootyBox (ignores wallet-specific balance/value).
        if (rows.length > 0 && typeof upsertTokenInfoPayload === 'function') {
          await upsertTokenInfoPayload(walletMetaResp);
        }

        wallet.lastMetaRefreshAt = Date.now();
      } catch (metaErr) {
        const msg = metaErr && metaErr.message ? metaErr.message : metaErr;
        logger.error(`[HUD] Failed to fetch wallet token metadata for ${wallet.alias} ${wallet.pubkey} - ${msg}`);
      }
    }

    // Best-effort price lookup for all mints in this wallet using SolanaTracker Data API.
    const pricesByMint = {};
    const mints = Array.from(aggregated.keys());
    // Ensure SOL is always included so we can price the header, even if this wallet holds no SOL directly.
    if (!mints.includes(SOL_MINT)) {
      mints.push(SOL_MINT);
    }

    {
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
    }

    const tokenRows = [];
    for (const [mint, balance] of aggregated.entries()) {
      if (!(balance > 0)) continue;

      let baseline = wallet.startTokenBalances[mint];
      if (baseline == null) {
        baseline = balance;
        wallet.startTokenBalances[mint] = balance;
      }

      // META tick provides token metadata via getWalletTokens(); PRICE tick keeps this null.
      const tokenMeta = doMeta ? (walletTokenMetaByMint.get(mint) || null) : null;

      let symbol = '';
      let decimals = null;

      if (tokenMeta) {
        // Handle both single-token payloads and wallet-token rows (both may have `token`).
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

      // Fallback to prior values for symbol/decimals if not found
      const prev = prevByMint.get(mint) || null;
      // Preserve symbol and decimals if previously non-empty, and avoid overwriting with empty values
      if ((!symbol || symbol === '') && prev && prev.symbol) symbol = prev.symbol;
      if ((decimals == null || decimals === '') && prev && typeof prev.decimals === 'number') decimals = prev.decimals;

      // Optional debug: see what we're getting if symbol is still empty
      if (!symbol && tokenMeta && process.env.HUD_DEBUG_METADATA === '1') {
        // eslint-disable-next-line no-console
        logger.debug('[HUD] tokenMeta had no symbol', { mint, tokenMeta });
      }

      // Best-effort: derive richer market metrics from tokenMeta (available on META ticks).
      const metaMapped = tokenMeta ? mapCoinMeta(tokenMeta) : null;

      // priceUsd: prefer batched price ticks; fall back to tokenMeta pool price; fall back to prior.
      const priceUsdFromBatch = pricesByMint[mint];
      const priceUsd =
        priceUsdFromBatch != null && Number.isFinite(priceUsdFromBatch)
          ? priceUsdFromBatch
          : metaMapped && typeof metaMapped.priceUsd === 'number'
            ? metaMapped.priceUsd
            : prev && typeof prev.priceUsd === 'number'
              ? prev.priceUsd
              : null;

      // changePct: only available from tokenMeta events; preserve prior on PRICE ticks.
      const changePct =
        metaMapped && metaMapped.events
          ? metaMapped.events
          : prev && prev.changePct
            ? prev.changePct
            : null;

      // Best-effort pool metrics from the SolanaTracker payload (keys vary by provider/version).
      const pools = tokenMeta && Array.isArray(tokenMeta.pools) ? tokenMeta.pools : [];
      const primaryPool = pickPrimaryPool(pools);

      // Compute curve and risk fields
      const curvePct = tokenMeta ? extractCurvePct(pools) : (prev && typeof prev.curvePct === 'number' ? prev.curvePct : null);
      const { riskScore, top10Pct, sniperPct, devPct, riskTags } = tokenMeta
        ? extractRiskFields(tokenMeta)
        : {
            riskScore: prev && typeof prev.riskScore === 'number' ? prev.riskScore : null,
            top10Pct: prev && typeof prev.top10Pct === 'number' ? prev.top10Pct : null,
            sniperPct: prev && typeof prev.sniperPct === 'number' ? prev.sniperPct : null,
            devPct: prev && typeof prev.devPct === 'number' ? prev.devPct : null,
            riskTags: prev && Array.isArray(prev.riskTags) ? prev.riskTags : null,
          };

      const liquidityUsd = (() => {
        if (!primaryPool) return prev && typeof prev.liquidityUsd === 'number' ? prev.liquidityUsd : null;
        const liq = primaryPool.liquidity;
        const v =
          (liq && typeof liq.usd === 'number' ? liq.usd : null) ??
          (typeof primaryPool.liquidityUsd === 'number' ? primaryPool.liquidityUsd : null) ??
          (typeof primaryPool.liquidity === 'number' ? primaryPool.liquidity : null);
        return Number.isFinite(Number(v)) ? Number(v) : (prev && typeof prev.liquidityUsd === 'number' ? prev.liquidityUsd : null);
      })();

      const marketCapUsd = (() => {
        if (!primaryPool) return prev && typeof prev.marketCapUsd === 'number' ? prev.marketCapUsd : null;
        const mc = primaryPool.marketCap;
        const v =
          (mc && typeof mc.usd === 'number' ? mc.usd : null) ??
          (typeof primaryPool.marketCapUsd === 'number' ? primaryPool.marketCapUsd : null) ??
          (typeof primaryPool.marketCap === 'number' ? primaryPool.marketCap : null);
        return Number.isFinite(Number(v)) ? Number(v) : (prev && typeof prev.marketCapUsd === 'number' ? prev.marketCapUsd : null);
      })();

      // Compute usdEstimate from priceUsd, preserving prior estimate during META ticks
      const usdEstimate =
        priceUsd != null && Number.isFinite(priceUsd)
          ? priceUsd * balance
          : prev && typeof prev.usdEstimate === 'number'
            ? prev.usdEstimate
            : null;

      // Position snapshot (from sc_pnl_positions_live) to help the HUD show "up/down" per token.
      const pnl = wallet && wallet.pnlByMint ? wallet.pnlByMint[mint] : null;
      const entryUsd = pnl ? toNum(pnl.entryUsd ?? pnl.entry_usd) : null;
      const currentUsd = pnl ? toNum(pnl.currentUsd ?? pnl.current_usd) : null;
      const unrealizedPnlUsd = pnl ? toNum(pnl.uPnlUsd ?? pnl.unrealizedPnlUsd ?? pnl.unrealized_pnl_usd) : null;
      const realizedPnlUsd = pnl ? toNum(pnl.rPnlUsd ?? pnl.realizedPnlUsd ?? pnl.realized_pnl_usd) : null;

      const avgEntryUsd =
        entryUsd != null && Number.isFinite(entryUsd) ? entryUsd : null;

      const avgEntryPriceUsd =
        avgEntryUsd != null && Number.isFinite(avgEntryUsd) && balance > 0 ? avgEntryUsd / balance : null;

      // ROI%: prefer view-provided value if present; else compute from entry/current.
      const roiPctFromView =
        pnl ? toNum(pnl.roiPct ?? pnl.roi_pct ?? pnl.roi_percent ?? pnl.roiPercent) : null;

      const roiPct =
        roiPctFromView != null
          ? roiPctFromView
          : entryUsd != null && currentUsd != null && entryUsd !== 0
            ? ((currentUsd - entryUsd) / entryUsd) * 100
            : null;

      const position =
        entryUsd != null || currentUsd != null || unrealizedPnlUsd != null || realizedPnlUsd != null
          ? { entryUsd, currentUsd, unrealizedPnlUsd, realizedPnlUsd, roiPct, avgEntryUsd, avgEntryPriceUsd }
          : (prev && prev.position ? prev.position : null);

      // Compact line for HUD: show ONLY ROI% (uPnL dollars are already displayed elsewhere).
      const positionLine = (() => {
        const p = position;
        if (!p) return prev && prev.positionLine ? prev.positionLine : null;
        const pct = p.roiPct;
        const pctText =
          pct != null && Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : null;
        return pctText || (prev && prev.positionLine ? prev.positionLine : null);
      })();

      tokenRows.push({
        symbol,
        mint,
        balance,
        sessionDelta: balance - baseline,
        usdEstimate,
        decimals,
        priceUsd,
        changePct,
        liquidityUsd,
        marketCapUsd,
        curvePct,
        riskScore,
        top10Pct,
        sniperPct,
        devPct,
        riskTags,
        position,
        positionLine,
        // Preserve per-token SellOps intel across refresh cycles (SellOps arrives out-of-band).
        sellOps: prev && prev.sellOps ? prev.sellOps : null,
        sellOpsLine: prev && prev.sellOpsLine ? prev.sellOpsLine : null,
      });
    }

    wallet.tokens = tokenRows;
    wallet.lastActivityTs = now;
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Failed to fetch tokens for ${wallet.alias} ${wallet.pubkey} - ${msg}`);
  }
}

/**
 * Refresh token balances for all wallets and update HUD state.
 *
 * @param {*} rpcMethods
 * @param {Record<string,WalletState>} state
 * @param {{emitChange: Function}|null} hudStore
 * @param {object} [opts] - options, e.g. { mode: 'meta' | 'price' }
 * @returns {Promise<void>}
 */
async function refreshAllTokenBalances(rpcMethods, state, hudStore, opts = {}) {
  const aliases = Object.keys(state);
  if (!rpcMethods || typeof rpcMethods.getTokenAccountsByOwnerV2 !== 'function' || aliases.length === 0) {
    return;
  }

  const tokenStart = Date.now();

  await Promise.all(
    aliases.map(async (alias) => {
      const wallet = state[alias];
      await refreshTokenBalancesForWallet(rpcMethods, wallet, opts);
    })
  );
  rpcStats.lastTokenMs = Date.now() - tokenStart;
  if (hudStore) hudStore.emitChange();
}

// Helper to normalize numeric values, especially from DB or API rows.
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize a PnL row to provide consistent camelCase and snake_case fields and computed values.
function normalizePnlRow(row) {
  if (!row || typeof row !== 'object') return row;

  // Common numeric fields we might use/emit.
  const currentTokenAmount = toNum(row.current_token_amount ?? row.currentTokenAmount ?? row.token_amount ?? row.tokenAmount);

  // sc_pnl_positions_live fields (preferred in the HUD)
  const avgCostUsd = toNum(row.avg_cost_usd ?? row.avgCostUsd ?? row.avg_cost ?? row.avgCost);
  const coinPriceUsd = toNum(row.coin_price_usd ?? row.coinPriceUsd ?? row.price_usd ?? row.priceUsd);
  const unrealizedUsdFromView = toNum(row.unrealized_usd ?? row.unrealizedUsd ?? row.unrealized_pnl_usd ?? row.unrealizedPnlUsd);
  const realizedUsdFromView = toNum(row.realized_usd ?? row.realizedUsd ?? row.realized_pnl_usd ?? row.realizedPnlUsd);

  const entryUsdRaw =
    toNum(row.entry_usd ?? row.entryUsd ?? row.entry_value_usd ?? row.entryValueUsd ?? row.cost_basis_usd ?? row.costBasisUsd);

  // If the view provides avg_cost_usd (cost per token), derive entry value as avg_cost_usd * current amount.
  const entryUsd =
    entryUsdRaw != null
      ? entryUsdRaw
      : avgCostUsd != null && currentTokenAmount != null
        ? avgCostUsd * currentTokenAmount
        : null;

  const currentUsdRaw =
    toNum(row.current_usd ?? row.currentUsd ?? row.current_value_usd ?? row.currentValueUsd ?? row.value_usd ?? row.valueUsd);

  // If the view provides coin_price_usd (current price per token), derive current value as price * current amount.
  const currentUsd =
    currentUsdRaw != null
      ? currentUsdRaw
      : coinPriceUsd != null && currentTokenAmount != null
        ? coinPriceUsd * currentTokenAmount
        : null;

  const unrealizedUsd =
    unrealizedUsdFromView != null
      ? unrealizedUsdFromView
      : toNum(
          row.unrealized_pnl_usd ??
            row.unrealizedPnlUsd ??
            row.upnl_usd ??
            row.uPnlUsd ??
            row.unrealized_usd ??
            row.unrealizedUsd
        );

  const realizedUsd =
    realizedUsdFromView != null
      ? realizedUsdFromView
      : toNum(
          row.realized_pnl_usd ??
            row.realizedPnlUsd ??
            row.rpnl_usd ??
            row.rPnlUsd ??
            row.realized_usd ??
            row.realizedUsd
        );

  // Best-effort compute uPnL if the view doesn't provide it.
  const computedUnrealizedUsd =
    unrealizedUsd != null
      ? unrealizedUsd
      : currentUsd != null && entryUsd != null
        ? currentUsd - entryUsd
        : null;

  // ROI%: prefer per-token price ratio when avg_cost_usd and coin_price_usd are available.
  const roiPctFromPrices =
    avgCostUsd != null && avgCostUsd !== 0 && coinPriceUsd != null
      ? ((coinPriceUsd / avgCostUsd) - 1) * 100
      : null;

  const roiPctComputed =
    roiPctFromPrices != null
      ? roiPctFromPrices
      : computedUnrealizedUsd != null && entryUsd != null && entryUsd !== 0
        ? (computedUnrealizedUsd / entryUsd) * 100
        : null;

  // Return a superset so Ink/UI can reference either snake_case or camelCase.
  return {
    ...row,
    current_token_amount: currentTokenAmount ?? row.current_token_amount,
    currentTokenAmount: currentTokenAmount ?? row.currentTokenAmount,

    entry_usd: entryUsd ?? row.entry_usd,
    entryUsd: entryUsd ?? row.entryUsd,

    current_usd: currentUsd ?? row.current_usd,
    currentUsd: currentUsd ?? row.currentUsd,

    unrealized_pnl_usd: computedUnrealizedUsd ?? row.unrealized_pnl_usd,
    unrealizedPnlUsd: computedUnrealizedUsd ?? row.unrealizedPnlUsd,
    uPnlUsd: computedUnrealizedUsd ?? row.uPnlUsd,

    realized_pnl_usd: realizedUsd ?? row.realized_pnl_usd,
    realizedPnlUsd: realizedUsd ?? row.realizedPnlUsd,
    rPnlUsd: realizedUsd ?? row.rPnlUsd,

    // Preserve common live-view fields for downstream UI/debug.
    avg_cost_usd: avgCostUsd ?? row.avg_cost_usd,
    avgCostUsd: avgCostUsd ?? row.avgCostUsd,

    coin_price_usd: coinPriceUsd ?? row.coin_price_usd,
    coinPriceUsd: coinPriceUsd ?? row.coinPriceUsd,

    roi_pct: roiPctComputed ?? row.roi_pct,
    roiPct: roiPctComputed ?? row.roiPct,
  };
}

// ---------- main loop ----------

/**
 * Refresh campaign PnL positions from the sc_pnl_positions_live view.
 * We only keep active/live positions (current_token_amount > 0).
 *
 * @param {Record<string,WalletState>} state
 * @param {{emitChange: Function}|null} hudStore
 */
async function refreshPnlPositions(state, hudStore) {
  const aliases = Object.keys(state || {});
  if (!aliases.length) return;

  await Promise.all(
    aliases.map(async (alias) => {
      const wallet = state[alias];
      await refreshPnlPositionsForWallet(wallet);
    })
  );

  if (hudStore) hudStore.emitChange();
}

/**
 * Refresh live PnL positions for a single wallet.
 *
 * @param {WalletState} wallet
 * @returns {Promise<void>}
 */
async function refreshPnlPositionsForWallet(wallet) {
  if (!wallet || wallet.walletId == null) return;

  try {
    const rows = await BootyBox.getPnlPositionsLive({ walletId: wallet.walletId });
    const byMint = {};
    for (const row of rows || []) {
      const mint = row && (row.coin_mint || row.coinMint || row.mint);
      if (!mint) continue;

      // Live-only: ignore closed/empty positions.
      const amt = row.current_token_amount != null ? Number(row.current_token_amount) : null;
      if (!(amt > 0)) continue;

      byMint[mint] = normalizePnlRow(row);
    }
    wallet.pnlByMint = byMint;
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to refresh live PnL positions for ${wallet.alias}: ${msg}`);
  }
}

/**
 * Create a per-wallet refresh scheduler so log events can immediately refresh token rows.
 *
 * @param {object} deps
 * @param {Record<string,WalletState>} deps.state
 * @param {Function} deps.getRpcMethods
 * @param {Function} deps.emitHudChange
 * @returns {(alias: string, reason?: string) => void}
 */
function createWalletTokenRefreshScheduler({ state, getRpcMethods, emitHudChange }) {
  const entries = new Map();

  const schedule = (alias, reason) => {
    const wallet = state && state[alias];
    if (!wallet) return;

    let entry = entries.get(alias);
    if (!entry) {
      entry = {
        timer: null,
        inFlight: false,
        pending: false,
        lastReason: null,
      };
      entries.set(alias, entry);
    }

    entry.lastReason = reason || entry.lastReason;
    if (entry.timer) {
      entry.pending = true;
      return;
    }

    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (entry.inFlight) {
        entry.pending = true;
        return;
      }

      entry.inFlight = true;
      const rpcMethods = typeof getRpcMethods === 'function' ? getRpcMethods() : null;
      try {
        await refreshTokenBalancesForWallet(rpcMethods, wallet, { mode: 'price' });
        await refreshPnlPositionsForWallet(wallet);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Fast token refresh failed for ${wallet.alias}: ${msg}`);
      } finally {
        entry.inFlight = false;
        if (typeof emitHudChange === 'function') emitHudChange();
        if (entry.pending) {
          entry.pending = false;
          schedule(alias, entry.lastReason || 'pending');
        }
      }
    }, WARCHEST_LOG_REFRESH_DEBOUNCE_MS);
  };

  return schedule;
}

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

  const sessionState = {
    id: null,
    serviceInstanceId: SERVICE_INSTANCE_ID,
    startSlot: null,
    startBlockTime: null,
    startedAt: null,
    lastHeartbeatAt: null,
    lastHeartbeatSlot: null,
    lastHeartbeatBlockTime: null,
  };

  let hudStore = null;
  let emitHudChange = () => {};

  async function finalizeSession(reason = 'clean', overrides = {}) {
    if (!sessionState.id || typeof BootyBox.endSession !== 'function') return null;

    const overrideSlot = Number.isFinite(Number(overrides.slot)) ? Math.trunc(Number(overrides.slot)) : null;
    const overrideBlock = Number.isFinite(Number(overrides.blockTimeMs))
      ? Math.trunc(Number(overrides.blockTimeMs))
      : null;

    const fallbackChainSlot = getChainState()?.slot ?? null;
    const endSlot =
      overrideSlot ??
      sessionState.lastHeartbeatSlot ??
      fallbackChainSlot ??
      sessionState.startSlot ??
      null;
    const endBlockTime =
      overrideBlock ??
      sessionState.lastHeartbeatBlockTime ??
      sessionState.startBlockTime ??
      null;

    let row = null;
    try {
      row = BootyBox.endSession({
        sessionId: sessionState.id,
        endSlot,
        endBlockTime,
        reason,
      });
      logger.info(
        `[HUD] Session ${sessionState.id} closed (${reason}) slot=${endSlot ?? 'n/a'} blockTime=${endBlockTime ?? 'n/a'}`
      );
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to close session ${sessionState.id} (${reason}): ${msg}`);
    } finally {
      sessionState.id = null;
      if (hudStore) hudStore.emitChange();
    }
    return row;
  }

  sessionFinalizer = finalizeSession;

  try {
    const closed = closeLingeringSession({
      BootyBox,
      statusPath: WARCHEST_STATUS_FILE,
      service: SESSION_SERVICE_NAME,
      reason: 'crash',
    });

    if (closed && closed.closed) {
      logger.warn(
        `[HUD] Closed stale session ${closed.session?.session_id ?? 'unknown'} before starting a new service run.`
      );
    }
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to close stale session on startup: ${msg}`);
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

  // In HUD mode, keep stdout reserved for Ink. Route log-like writes to stderr.
  let removeStdoutGuard = null;
  if (mode === 'hud') {
    removeStdoutGuard = installHudStdoutGuard();
  }

  const state = buildInitialState(resolvedWallets);
  const serviceAlerts = [];

  const wsSupervisor = createWsSupervisor({
    staleAfterMs: WARCHEST_WS_STALE_MS,
    minRestartGapMs: WARCHEST_WS_RESTART_GAP_MS,
    maxBackoffMs: WARCHEST_WS_RESTART_MAX_BACKOFF_MS,
  });

  hudStore = createHudStore(() => ({
    state,
    lastSolPriceUsd,
    rpcStats: { ...rpcStats },
    hudMaxTx: HUD_MAX_TX,
    hudMaxLogs: HUD_MAX_LOGS,
    service: {
      wsSupervisor: wsSupervisor.getStatus(),
      sockets: rpcSocketRegistry ? rpcSocketRegistry.size : null,
      alerts: serviceAlerts.slice(0, 8),
    },
    sellOps: JSON.parse(JSON.stringify(sellOpsState)),
    transactions: txFeed.slice(0, HUD_MAX_TX),
    session: sessionState.id
      ? {
          sessionId: sessionState.id,
          startedAt: sessionState.startedAt,
          startSlot: sessionState.startSlot,
          startBlockTime: sessionState.startBlockTime,
          lastRefreshAt: sessionState.lastHeartbeatAt,
          lastRefreshSlot: sessionState.lastHeartbeatSlot,
          lastRefreshBlockTime: sessionState.lastHeartbeatBlockTime,
          serviceInstanceId: sessionState.serviceInstanceId,
        }
      : null,
  }));

  emitHudChange = createThrottledEmitter(() => hudStore.emitChange(), WARCHEST_HUD_EMIT_THROTTLE_MS);
  const scheduleWalletTokenRefresh = createWalletTokenRefreshScheduler({
    state,
    getRpcMethods: () => rpcMethods,
    emitHudChange,
  });

  // ---- SellOps workers (one per wallet alias) ----
  const sellOpsWorkers = {}; // alias -> { stop }

      async function startSellOpsWorkers() {
        for (const w of resolvedWallets) {
          if (!w || !w.alias) continue;
          if (sellOpsWorkers[w.alias]) continue;

          // Seed state so HUD shows "starting" immediately.
          upsertSellOpsHeartbeat(w.alias, {
            ts: Date.now(),
            walletAlias: w.alias,
            status: 'starting',
            openPositions: null,
            nextTickMs: 60_000,
          });

          try {
            const workerPath = path.join(__dirname, 'sellOpsWorker.js');
            const pollIntervalMs = 60_000;

            const handle = forkWorkerWithPayload(workerPath, {
              // SellOps is a long-lived streaming worker; do not apply a request/response timeout.
              timeoutMs: 0,
              payload: {
                walletAlias: w.alias,
                // Provide a fully-resolved wallet spec so the child can call setup() without re-resolving.
                wallet: { alias: w.alias, pubkey: w.pubkey || null, color: w.color || null },
                walletPubkey: w.pubkey || null,
                // Explicitly pass the data endpoint (the child currently logs env presence).
                dataEndpoint: process.env.WARCHEST_DATA_ENDPOINT || null,

                pollIntervalMs,
                // Defaults aligned with evaluationService
                ohlcvType: '1m',
                ohlcvLookbackMs: 60 * 60 * 1000,
                vwapPeriods: 60,
                includeCandles: false,
                // Keep event intervals consistent with your prior plan
                eventIntervals: ['5m', '15m', '1h'],
              },
              onProgress: (msg) => {
                // Harness forwards full message objects for custom events.
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'sellOps:heartbeat') {
                  const hb = msg.payload || null;
                  const alias = hb?.walletAlias || w.alias;
                  upsertSellOpsHeartbeat(alias, hb);

                  // Throttled HUD alert so we can see SellOps is actually ticking.
                  const now = Date.now();
                  const last = sellOpsLastHeartbeatAlert.get(alias) || 0;
                  if (now - last > pollIntervalMs) {
                    sellOpsLastHeartbeatAlert.set(alias, now);
                    const status = hb?.status || 'ok';
                    const open = hb?.openPositions ?? 'n/a';
                    pushServiceAlert(serviceAlerts, 'info', `SellOps heartbeat (${alias}) status=${status} open=${open}`);
                  }

                  emitHudChange();
                  return;
                }

                if (msg.type === 'sellOps:evaluation') {
                  const p = msg.payload || null;
                  const alias = p?.walletAlias || w.alias;
                  const mint = p?.mint || null;
                  if (mint) {
                    upsertSellOpsEvaluation(alias, mint, p);
                  }

                  // Always persist latest SellOps intel onto the token row so the HUD can show per-token freshness,
                  // even when Recent Activity is rate-limited.
                  if (mint && state?.[alias] && Array.isArray(state[alias].tokens)) {
                    const tokenRow = state[alias].tokens.find((t) => t && t.mint === mint) || null;
                    if (tokenRow) {
                      const ts = Number.isFinite(Number(p?.ts)) ? Number(p.ts) : Date.now();
                      const recommendation = p?.recommendation || 'hold';
                      const strategyName = p?.strategy?.name || null;
                      const qualifyWorst = p?.qualify?.worstSeverity || 'none';
                      const qualifyFailed = Number.isFinite(Number(p?.qualify?.failedCount)) ? Number(p.qualify.failedCount) : 0;
                      const regime = p?.regime?.status || null;

                      // Best-effort failing gate id (naming differs across strategy/evaluation versions).
                      const gateFail =
                        p?.gateFail ||
                        p?.qualify?.gateFail ||
                        (Array.isArray(p?.qualify?.failed) && p.qualify.failed[0] && (p.qualify.failed[0].gate || p.qualify.failed[0].gateId)) ||
                        null;

                      tokenRow.sellOps = {
                        ts,
                        recommendation,
                        strategyName,
                        qualifyWorst,
                        qualifyFailed,
                        regime,
                        gateFail,
                      };

                      const stratPart = strategyName ? ` ${strategyName}` : '';
                      const qPart = qualifyFailed > 0
                        ? ` gates=${qualifyFailed} sev=${qualifyWorst}${gateFail ? ` gate=${gateFail}` : ''}`
                        : ' qualify=pass';
                      tokenRow.sellOpsLine = `SellOps ${recommendation}${stratPart}${qPart}`;
                    }
                  }

                  // Brief HUD-visible event (rate-limited): show intel, not execution decision.
                  const gateFail =
                    p?.gateFail ||
                    p?.qualify?.gateFail ||
                    (Array.isArray(p?.qualify?.failed) && p.qualify.failed[0] && (p.qualify.failed[0].gate || p.qualify.failed[0].gateId)) ||
                    null;

                  const decision = p?.decision || 'n/a'; // still useful in alerts/debug
                  const recommendation = p?.recommendation || 'hold';
                  const strategyName = p?.strategy?.name || null;
                  const qualifyWorst = p?.qualify?.worstSeverity || 'none';
                  const qualifyFailed = Number.isFinite(Number(p?.qualify?.failedCount)) ? Number(p.qualify.failedCount) : 0;

                  const regime = p?.regime?.status || 'n/a';
                  const symbol =
                    p?.symbol ||
                    state?.[alias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
                    (mint ? mint.slice(0, 4) : 'mint');

                  const intel = { recommendation, worstSeverity: qualifyWorst, failedCount: qualifyFailed };

                  if (mint && shouldDisplaySellOpsEvent(alias, mint, intel)) {
                    const stratPart = strategyName ? ` ${strategyName}` : '';
                    const qPart = qualifyFailed > 0
                      ? ` gates=${qualifyFailed} sev=${qualifyWorst}${gateFail ? ` gate=${gateFail}` : ''}`
                      : ' qualify=pass';
                    const line = `SellOps ${symbol} ${recommendation}${stratPart} (${regime})${qPart}`;

                    pushRecentEvent(state[alias], line, hudStore);

                    // Keep serviceAlerts concise but still useful; include decision for safety debugging.
                    pushServiceAlert(
                      serviceAlerts,
                      'info',
                      `SellOps eval (${alias}) ${symbol} recommend=${recommendation}${stratPart} (${regime})${qPart} decision=${decision}`
                    );
                  }

                  emitHudChange();
                }

                if (msg.type === 'sellOps:autopsy') {
                  const p = msg.payload || null;
                  const alias = p?.walletAlias || w.alias;
                  const mint = p?.mint || null;
                  const grade = p?.grade || 'n/a';
                  const summaryRaw = p?.summary || '';
                  const summary = summaryRaw && summaryRaw.length > 140
                    ? `${summaryRaw.slice(0, 137)}...`
                    : summaryRaw;
                  const symbol =
                    state?.[alias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
                    (mint ? mint.slice(0, 4) : 'mint');

                  if (state?.[alias]) {
                    const text = summary
                      ? `SellOps Autopsy ${symbol} ${grade}: ${summary}`
                      : `SellOps Autopsy ${symbol} ${grade}`;
                    pushRecentEvent(state[alias], text, hudStore);
                  }

                  pushSellOpsAutopsy(alias, {
                    ts: p?.ts || Date.now(),
                    walletAlias: alias,
                    tradeUuid: p?.tradeUuid || null,
                    mint,
                    grade: p?.grade || null,
                    summary: p?.summary || null,
                    tags: Array.isArray(p?.tags) ? p.tags : [],
                    ai: p?.ai || null,
                    artifactPath: p?.artifactPath || null,
                  });

                  const alertSummary = summary
                    ? ` summary="${summary}"`
                    : '';
                  pushServiceAlert(serviceAlerts, 'info', `SellOps autopsy (${alias}) ${symbol} grade=${grade}${alertSummary}`);
                  emitHudChange();
                }
              },
            });

            sellOpsWorkers[w.alias] = {
              stop: () => {
                try { handle?.stop?.(); } catch {}
              },
            };

            pushServiceAlert(serviceAlerts, 'info', `SellOps worker started (${w.alias})`);
          } catch (err) {
            const msg = err && err.message ? err.message : err;
            pushServiceAlert(serviceAlerts, 'error', `SellOps worker failed (${w.alias}): ${msg}`);
            logger.warn(`[HUD] Failed to start SellOps worker for ${w.alias}: ${msg}`);
            upsertSellOpsHeartbeat(w.alias, {
              ts: Date.now(),
              walletAlias: w.alias,
              status: 'error',
              openPositions: null,
              nextTickMs: 60_000,
              err: msg,
            });
          }
        }

        if (hudStore) hudStore.emitChange();
      }

  // Start SellOps monitors per wallet (best-effort; does not block HUD startup).
  startSellOpsWorkers().catch((err) => {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] startSellOpsWorkers failed: ${msg}`);
  });

  // Follow hub/tx monitor events file for transaction feed.
  try {
    eventFollower = createHubEventFollower({ readInitial: true });
    eventFollower.onEvents((events) => {
      ingestTxEvents(events, hudStore).catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to ingest tx events: ${msg}`);
      });
    });
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to start event follower: ${msg}`);
  }
  writePidFile();

  // Create SolanaTracker RPC client (HTTP + WS).
  let rpcClient = null;
  let rpc = null;
  let rpcSubs = null;
  let close = null;
  let rpcMethods = null;

  function bindRpcClient(client) {
    rpcClient = client;
    rpc = client ? client.rpc : null;
    rpcSubs = client ? client.rpcSubs : null;
    close = client ? client.close : null;
    rpcMethods = client ? createRpcMethods(client.rpc, client.rpcSubs) : null;
    rpcSocketRegistry = client ? client.socketRegistry || null : null;
  }

  function createFreshRpcClient() {
    const client = createSolanaTrackerRPCClient();
    return {
      rpc: client.rpc,
      rpcSubs: client.rpcSubs,
      close: client.close,
      socketRegistry: client.socketRegistry,
    };
  }

  bindRpcClient(createFreshRpcClient());

  const blockTimeCache = {
    slot: null,
    blockTimeMs: null,
  };
  let lastBlockTimeAlertAt = 0;

  async function resolveBlockTimeMs(slot) {
    if (!Number.isFinite(Number(slot)) || Number(slot) <= 0) return null;
    if (!rpc || typeof rpc.getBlockTime !== 'function') return null;

    const normalizedSlot = Number(slot);
    if (blockTimeCache.slot === normalizedSlot && blockTimeCache.blockTimeMs != null) {
      return blockTimeCache.blockTimeMs;
    }

    try {
      const blockTimeSeconds = await rpc.getBlockTime(normalizedSlot).send();
      if (!Number.isFinite(Number(blockTimeSeconds))) return null;
      const blockTimeMs = Math.trunc(Number(blockTimeSeconds) * 1000);
      blockTimeCache.slot = normalizedSlot;
      blockTimeCache.blockTimeMs = blockTimeMs;
      return blockTimeMs;
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      wsSupervisor.noteError(err, 'rpc.getBlockTime');
      const now = Date.now();
      if (now - lastBlockTimeAlertAt > 60_000) {
        lastBlockTimeAlertAt = now;
        pushServiceAlert(serviceAlerts, 'warn', `RPC getBlockTime failed: ${msg}`);
        if (hudStore) hudStore.emitChange();
      }
      logger.warn(`[HUD] Failed to fetch block time for slot ${normalizedSlot}: ${msg}`);
      return null;
    }
  }

  async function fetchSlotAnchor() {
    if (!rpc || typeof rpc.getSlot !== 'function') return { slot: null, blockTimeMs: null };
    try {
      const slotRes = await rpc.getSlot().send();
      const slotValue = slotRes && typeof slotRes.value !== 'undefined' ? slotRes.value : slotRes;
      const slot = Number(
        typeof slotValue === 'bigint' ? Number(slotValue) : slotValue
      );
      if (!Number.isFinite(slot) || slot <= 0) {
        return { slot: null, blockTimeMs: null };
      }
      const blockTimeMs = await resolveBlockTimeMs(slot);
      return { slot, blockTimeMs };
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to fetch slot anchor for session start: ${msg}`);
      return { slot: null, blockTimeMs: null };
    }
  }

  async function ensureSessionStarted() {
    if (sessionState.id != null) return;
    if (typeof BootyBox.startSession !== 'function') {
      logger.warn('[HUD] BootyBox.startSession unavailable; session tracking disabled.');
      return;
    }

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { slot, blockTimeMs } = await fetchSlotAnchor();
      if (slot) {
        try {
          const sessionId = BootyBox.startSession({
            service: SESSION_SERVICE_NAME,
            serviceInstanceId: sessionState.serviceInstanceId,
            startSlot: slot,
            startBlockTime: blockTimeMs,
          });
          const now = Date.now();
          sessionState.id = sessionId;
          sessionState.startSlot = slot;
          sessionState.startBlockTime = blockTimeMs ?? null;
          sessionState.startedAt = now;
          sessionState.lastHeartbeatSlot = slot;
          sessionState.lastHeartbeatBlockTime = blockTimeMs ?? null;
          sessionState.lastHeartbeatAt = now;
          logger.info(`[HUD] BootyBox session started (session_id=${sessionId}, slot=${slot}).`);
          return;
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.error(
            `[HUD] Failed to start BootyBox session (attempt ${attempt}/${maxAttempts}): ${msg}`
          );
          if (attempt === maxAttempts) throw err;
        }
      }

      await wait(Math.min(1000 * attempt, 5000));
    }

    throw new Error('Failed to determine Solana slot for session start.');
  }

  await ensureSessionStarted();

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

  function applyRpcToWalletManagers(nextRpc) {
    if (!nextRpc) return;
    for (const wm of Object.values(walletManagers)) {
      if (wm && typeof wm === 'object') {
        // WalletManagerV2 currently does not call this.rpc, but we keep it fresh
        // so future enhancements do not read from a stale RPC client.
        // eslint-disable-next-line no-param-reassign
        wm.rpc = nextRpc;
      }
    }
  }

  async function unsubscribeAllSubs(reason) {
    const label = reason ? `unsubscribe (${reason})` : 'unsubscribe';

    if (slotSub && typeof slotSub.unsubscribe === 'function') {
      try {
        await withTimeout(slotSub.unsubscribe(), WARCHEST_WS_UNSUB_TIMEOUT_MS, `${label}: slotSub`);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] ${label}: slot unsubscribe failed: ${msg}`);
      }
    }
    slotSub = null;

    try {
      for (const sub of accountSubs.splice(0, accountSubs.length)) {
        if (sub && typeof sub.unsubscribe === 'function') {
          try {
            await withTimeout(sub.unsubscribe(), WARCHEST_WS_UNSUB_TIMEOUT_MS, `${label}: accountSub`);
          } catch (err) {
            const msg = err && err.message ? err.message : err;
            logger.warn(`[HUD] ${label}: account unsubscribe failed: ${msg}`);
          }
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] ${label}: account unsubscribe loop failed: ${msg}`);
    }

    try {
      for (const sub of logsSubs.splice(0, logsSubs.length)) {
        if (sub && typeof sub.unsubscribe === 'function') {
          try {
            await withTimeout(sub.unsubscribe(), WARCHEST_WS_UNSUB_TIMEOUT_MS, `${label}: logsSub`);
          } catch (err) {
            const msg = err && err.message ? err.message : err;
            logger.warn(`[HUD] ${label}: logs unsubscribe failed: ${msg}`);
          }
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] ${label}: logs unsubscribe loop failed: ${msg}`);
    }
  }

  let reconnectPromise = null;
  async function reconnectRpcClient(reason, err) {
    if (reconnectPromise) return reconnectPromise;
    if (!wsSupervisor.beginRestart(reason || 'restart')) return null;

    if (err) wsSupervisor.noteError(err, reason || 'restart');

    const restartReason = reason || 'restart';
    pushServiceAlert(serviceAlerts, 'warn', `Restarting RPC/WS (${restartReason})`);
    if (hudStore) hudStore.emitChange();

    reconnectPromise = (async () => {
      let ok = false;
      try {
        await unsubscribeAllSubs('reconnect');

        if (typeof close === 'function') {
          try {
            await withTimeout(close(), WARCHEST_WS_UNSUB_TIMEOUT_MS, 'rpcClient.close');
          } catch (closeErr) {
            const msg = closeErr && closeErr.message ? closeErr.message : closeErr;
            logger.warn(`[HUD] RPC client close timed out/failed during reconnect: ${msg}`);
          }
        }

        bindRpcClient(createFreshRpcClient());
        applyRpcToWalletManagers(rpc);

        // Reset cached block time on client restart to avoid coupling to the old transport.
        blockTimeCache.slot = null;
        blockTimeCache.blockTimeMs = null;

        await startSubscriptions();
        ok = true;
        pushServiceAlert(serviceAlerts, 'info', `RPC/WS restarted (${restartReason})`);
      } catch (restartErr) {
        wsSupervisor.noteError(restartErr, 'reconnect');
        const msg = restartErr && restartErr.message ? restartErr.message : restartErr;
        pushServiceAlert(serviceAlerts, 'error', `RPC/WS restart failed: ${msg}`);
        logger.error(`[HUD] RPC/WS restart failed: ${msg}`);
      } finally {
        wsSupervisor.endRestart(ok);
        if (hudStore) hudStore.emitChange();
        reconnectPromise = null;
      }
    })();

    return reconnectPromise;
  }

  function requestReconnect(reason, err) {
    // Fire and forget; supervisor enforces cooldown/backoff.
    Promise.resolve()
      .then(() => reconnectRpcClient(reason, err))
      .catch((reErr) => {
        const msg = reErr && reErr.message ? reErr.message : reErr;
        logger.warn(`[HUD] reconnect request failed: ${msg}`);
      });
  }

  async function startSubscriptions() {
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

                const wm = walletManagers[alias];
                if (wm && typeof wm.handleLogNotification === 'function') {
                  Promise.resolve(wm.handleLogNotification(ev)).catch((wmErr) => {
                    const wmsg = wmErr && wmErr.message ? wmErr.message : wmErr;
                    logger.warn(`[HUD] WalletManagerV2 error for ${wallet.alias}: ${wmsg}`);
                  });
                }

                if (typeof scheduleWalletTokenRefresh === 'function') {
                  scheduleWalletTokenRefresh(wallet.alias, 'logs');
                }
              } catch (logErr) {
                const msg = logErr && logErr.message ? logErr.message : logErr;
                logger.warn(`[HUD] Error processing logs event for ${wallet.alias}: ${msg}`);
              }
            },
            {
              onError: (subErr) => {
                wsSupervisor.noteError(subErr, `logsSub:${wallet.alias}`);
                pushServiceAlert(serviceAlerts, 'error', `logsSubscribe error (${wallet.alias}): ${subErr?.message || subErr}`);
                if (hudStore) hudStore.emitChange();
                requestReconnect('ws_logs_error', subErr);
              },
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

    logger.info('[HUD] SolanaTracker RPC client initialized.');
    if (!rpcSubs) {
      // eslint-disable-next-line no-console
      logger.warn('[HUD] rpcSubs is null; WS subscriptions are disabled (no SOLANATRACKER_RPC_WS_URL?).');
    }

    if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeSlot === 'function') {
      try {
        logger.info('[HUD] Subscribing to slot updates for chain heartbeat.');
        slotSub = await rpcMethods.subscribeSlot(
          (ev) => {
            updateFromSlotEvent(ev);
            if (hudStore) hudStore.emitChange();
          },
          {
            onError: (subErr) => {
              wsSupervisor.noteError(subErr, 'slotSub');
              pushServiceAlert(serviceAlerts, 'error', `slotSubscribe error: ${subErr?.message || subErr}`);
              if (hudStore) hudStore.emitChange();
              requestReconnect('ws_slot_error', subErr);
            },
          }
        );
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        wsSupervisor.noteError(err, 'subscribeSlot');
        pushServiceAlert(serviceAlerts, 'error', `Failed to subscribe slot updates: ${msg}`);
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

          const sub = await rpcMethods.subscribeAccount(
            wallet.pubkey,
            (ev) => {
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

                if (hudStore) hudStore.emitChange();
              } catch (updateErr) {
                const msg = updateErr && updateErr.message ? updateErr.message : updateErr;
                logger.warn(`[HUD] Error processing SOL account update for ${wallet.alias}: ${msg}`);
              }
            },
            {
              onError: (subErr) => {
                wsSupervisor.noteError(subErr, `accountSub:${wallet.alias}`);
                pushServiceAlert(serviceAlerts, 'error', `accountSubscribe error (${wallet.alias}): ${subErr?.message || subErr}`);
                if (hudStore) hudStore.emitChange();
                requestReconnect('ws_account_error', subErr);
              },
            }
          );

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
  }

  await startSubscriptions();

  // Initial SOL balance fetch
  await refreshAllSolBalances(rpcMethods, state, hudStore);
  await refreshAllTokenBalances(rpcMethods, state, hudStore, { mode: 'meta' });
  await refreshPnlPositions(state, hudStore);

  // Periodic SOL refresh using HTTP RPC
  const solTimer = setInterval(() => {
    refreshAllSolBalances(rpcMethods, state, hudStore).catch((err) => {
      logger.error('[HUD] Error refreshing SOL balances:', err.message || err);
    });
  }, HUD_SOL_REFRESH_SEC * 1000);

  const tokenTimer = setInterval(() => {
    hudMetaRefreshTick = !hudMetaRefreshTick;
    const mode = hudMetaRefreshTick ? 'meta' : 'price';

    refreshAllTokenBalances(rpcMethods, state, hudStore, { mode }).catch((err) => {
      logger.error('[HUD] Error refreshing token balances:', err.message || err);
    });
    refreshPnlPositions(state, hudStore).catch((err) => {
      logger.warn('[HUD] Error refreshing live PnL positions:', err.message || err);
    });
  }, HUD_TOKENS_REFRESH_SEC * 1000);

  let healthUpdateInFlight = false;
  const healthTimer = setInterval(() => {
    if (healthUpdateInFlight) return;
    healthUpdateInFlight = true;

    Promise.resolve()
      .then(async () => {
        // WS watchdog: if we stop receiving slots for too long, restart the client.
        const chain = getChainState();
        const { shouldRestart, reason } = wsSupervisor.shouldRestartForStale(chain?.lastSlotAt ?? null);
        if (shouldRestart) {
          pushServiceAlert(serviceAlerts, 'warn', `WS heartbeat stale; restarting (${reason})`);
          if (hudStore) hudStore.emitChange();
          await reconnectRpcClient(reason);
        }

        const health = updateHealth(state, rpcStats, {
          wsSupervisor: wsSupervisor.getStatus(),
          socketCount: rpcSocketRegistry ? rpcSocketRegistry.size : null,
        });
        if (!health || !health.ws) return;

        const slot = Number.isFinite(Number(health.ws.slot)) ? Math.trunc(Number(health.ws.slot)) : null;
        let blockTimeMs = null;
        if (slot) {
          blockTimeMs = await resolveBlockTimeMs(slot);
          if (blockTimeMs != null) {
            health.ws.blockTimeMs = blockTimeMs;
          }
        }

        if (sessionState.id && slot && typeof BootyBox.updateSessionStats === 'function') {
          try {
            BootyBox.updateSessionStats({
              sessionId: sessionState.id,
              currentSlot: slot,
              currentBlockTime: blockTimeMs,
            });
            sessionState.lastHeartbeatSlot = slot;
            if (blockTimeMs != null) sessionState.lastHeartbeatBlockTime = blockTimeMs;
            sessionState.lastHeartbeatAt = Date.now();
            if (hudStore) hudStore.emitChange();
          } catch (err) {
            const msg = err && err.message ? err.message : err;
            logger.warn(`[HUD] Failed to update session heartbeat: ${msg}`);
          }
        }

        if (sessionState.id) {
          health.session = {
            sessionId: sessionState.id,
            serviceInstanceId: sessionState.serviceInstanceId,
            startedAt: sessionState.startedAt,
            startSlot: sessionState.startSlot,
            startBlockTime: sessionState.startBlockTime,
            lastRefreshAt: sessionState.lastHeartbeatAt,
            lastRefreshSlot: sessionState.lastHeartbeatSlot,
            lastRefreshBlockTime: sessionState.lastHeartbeatBlockTime,
          };
        }

        if (health.process && health.wallets) {
          // Persist a snapshot for other commands (and HUD) to inspect.
          // We write this in BOTH daemon and hud modes so the status file is always live
          // regardless of how the worker is launched.
          writeStatusSnapshot(health);

          if (mode === 'daemon') {
            const rssMb = Math.round(health.process.rssBytes / 1024 / 1024);
            const lagMs = health.process.eventLoopLagMs;
            const socketCount =
              health.service && typeof health.service.sockets === 'number'
                ? health.service.sockets
                : null;

            logger.info(
              `[warchest] Health: up=${health.process.uptimeSec}s rss=${rssMb}MB slot=${health.ws.slot} wsAge=${health.ws.lastSlotAgeMs}ms lag=${lagMs}ms wallets=${health.wallets.count} sockets=${socketCount != null ? socketCount : 'n/a'}`
            );
          }
        }
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Health update failed: ${msg}`);
      })
      .finally(() => {
        healthUpdateInFlight = false;
      });
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
    // Stop SellOps children
    try {
      for (const h of Object.values(sellOpsWorkers)) {
        if (h && typeof h.stop === 'function') {
          try { h.stop(); } catch {}
        }
      }
    } catch {}
    if (typeof removeStdoutGuard === 'function') {
      try { removeStdoutGuard(); } catch {}
      removeStdoutGuard = null;
    }
    if (inkApp && typeof inkApp.unmount === 'function') {
      inkApp.unmount();
    }
    if (hudStore && typeof hudStore.removeAllListeners === 'function') {
      hudStore.removeAllListeners();
    }
    Promise.resolve()
      .then(async () => {
        await unsubscribeAllSubs('shutdown');
        if (eventFollower && typeof eventFollower.close === 'function') {
          eventFollower.close();
        }
        return typeof close === 'function' ? close() : null;
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Error during RPC client close: ${msg}`);
      })
      .finally(async () => {
        try {
          await finalizeSession('clean');
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Failed to finalize session on shutdown: ${msg}`);
        } finally {
          removePidFile();
          process.exit(0);
        }
      });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run if invoked directly
if (require.main === module) {
  main().catch(async (err) => {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Fatal error: ${msg}`);
    if (typeof sessionFinalizer === 'function') {
      try {
        await sessionFinalizer('crash');
      } catch (finalErr) {
        const finalMsg = finalErr && finalErr.message ? finalErr.message : finalErr;
        logger.warn(`[HUD] Failed to finalize session after crash: ${finalMsg}`);
      }
    }
    removePidFile();
    process.exit(1);
  });
}
