#!/usr/bin/env node
"use strict";

// lib/warchest/workers/warchestService.js
// Long-running warchest service: given wallet info via CLI args,
// connect to SolanaTracker RPC, maintain state, and publish HUD snapshots.

require("../../env/safeDotenv").loadDotenv();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  createSolanaTrackerRPCClient,
} = require("../../solanaTrackerRPCClient");
const { createRpcMethods } = require("../../solana/rpcMethods");
const {
  createSolanaTrackerDataClient,
} = require("../../solanaTrackerDataClient");
const { upsertTokenInfoPayload } = require("../../services/tokenInfoService");
const {
  pruneTargetsWithVectorStoreCleanup,
} = require("../../services/targetPruning");
const { DEFAULT_HUD_REFRESH_PATH, DEFAULT_HUD_STATE_PATH } = require("../events");
const { getHubCoordinator, closeHubCoordinator } = require("../hub");
const baseLogger = require("../../logger");
const { createWorkerLogger } = require("./workerLogger");
const {
  updateFromSlotEvent,
  getChainState,
} = require("../../solana/rpcMethods/internal/chainState");
const { updateSol } = require("../../solana/rpcMethods/internal/walletState");
const { updateHealth } = require("../health");
const { fetchAllTokenAccounts } = require("../fetchAllTokenAccounts");
const { createWsSupervisor } = require("../wsSupervisor");
const { createWarlordAIClient } = require("../warlordAIClient");
const { createShutdownCoordinator } = require("./shutdownCoordinator");
const {
  pushServiceAlert,
  withTimeout,
  parseArgs,
  extractPriceChange,
  mapCoinMeta,
  pickPrimaryPool,
  extractCurvePct,
  extractRiskFields,
  createThrottledEmitter,
} = require("./warchestServiceHelpers");
const { resolveWalletSpecsWithRegistry } = require("../../wallets/resolver");
const { closeLingeringSession } = require("./sessionLifecycle");
const { forkWorkerWithPayload, safeSerializePayload } = require("./harness");
const { createSessionManager } = require("./warchest/sessionManager");
const { createSellOpsOrchestrator } = require("./warchest/sellOpsOrchestrator");
const { primeMasterKey } = require("../../wallets/keychainProvider");
const BUYOPS_WORKER_PATH = path.join(__dirname, "buyOpsWorker.js");
const TARGETOPS_WORKER_PATH = path.join(__dirname, "targetOpsWorker.js");
const POSITION_HEAL_WORKER_PATH = path.join(
  __dirname,
  "positionHealingWorker.js"
);

const SESSION_SERVICE_NAME = "warchest-service";
const SERVICE_INSTANCE_ID = crypto.randomUUID();
let sessionFinalizer = null;
let warlordAIClient = null;

const WalletManagerV2 = require("../../WalletManagerV2");
const txInsightService = require("../../services/txInsightService");

// Current RPC socket registry (populated by createSolanaTrackerRPCClient) for metrics/cleanup.
let rpcSocketRegistry = null;

const logger = createWorkerLogger({
  workerName: "warchestService",
  scope: "HUD",
  baseLogger,
  includeCallsite: true,
});
const metricsLogger =
  typeof baseLogger.metrics === "function" ? baseLogger.metrics() : baseLogger;
const dataLogger =
  typeof baseLogger.solanaTrackerData === "function"
    ? baseLogger.solanaTrackerData()
    : baseLogger;

function reportServiceMetric(event, extra) {
  if (!metricsLogger || typeof metricsLogger.debug !== "function") return;
  const payload = {
    worker: "warchestService",
    event,
    requestId: SERVICE_INSTANCE_ID,
    ...(extra || {}),
  };
  metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
}

function parseIntervalMs(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["off", "disabled", "false", "0", "no"].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

let BootyBox = {};
try {
  // BootyBox index should select the SQLite adapter.
  // If it is not available in this environment, we fall back to a no-op
  // object so WalletManagerV2 can still run without persisting trades.
  // Adjust the require path if your BootyBox entrypoint lives elsewhere.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  BootyBox = require("../../../db");
} catch (err) {
  const msg = err && err.message ? err.message : err;
  logger.warn(
    `[HUD] BootyBox module not available for WalletManagerV2: ${msg}`
  );
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
  if (!BootyBox || typeof BootyBox.init !== "function") {
    logger.error(
      "[HUD] BootyBox client unavailable; warchest cannot persist trades."
    );
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
  if (typeof BootyBox.recordScTradeEvent !== "function")
    missing.push("recordScTradeEvent");
  if (typeof BootyBox.startSession !== "function") missing.push("startSession");
  if (typeof BootyBox.endSession !== "function") missing.push("endSession");
  if (typeof BootyBox.updateSessionStats !== "function")
    missing.push("updateSessionStats");
  if (typeof BootyBox.getPnlPositionsLive !== "function")
    missing.push("getPnlPositionsLive");

  if (missing.length) {
    logger.error(
      `[HUD] BootyBox missing required helpers (${missing.join(
        ", "
      )}); warchest persistence disabled.`
    );
    return false;
  }

  // Optional helpers: used by discovery/resync flows; warn but do not disable persistence.
  if (typeof BootyBox.ensureOpenPositionRun !== "function") {
    logger.warn(
      "[HUD] BootyBox.ensureOpenPositionRun is not available; external/discovery holdings may not get a position-run trade_uuid until the first in-app trade."
    );
  }

  return true;
}

const WARCHEST_STATUS_DIR = path.join(process.cwd(), "data", "warchest");
const WARCHEST_STATUS_FILE = path.join(WARCHEST_STATUS_DIR, "status.json");
const WARCHEST_PID_FILE = path.join(WARCHEST_STATUS_DIR, "warchest.pid");

function resolveHudStatePath(targetPath) {
  if (!targetPath) return DEFAULT_HUD_STATE_PATH;
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(process.cwd(), targetPath);
}

/**
 * Write JSON to disk using a temp file + rename for atomicity.
 *
 * @param {string} targetPath
 * @param {object} payload
 */
function writeJsonAtomic(targetPath, payload) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, targetPath);
}

/**
 * Persist a lightweight health snapshot for other commands to read.
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

    writeJsonAtomic(WARCHEST_STATUS_FILE, snapshot);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to write warchest status snapshot: ${msg}`);
  }
}

/**
 * Persist a HUD snapshot for the HUD worker to render.
 *
 * @param {string|null} targetPath
 * @param {object} snapshot
 */
function writeHudSnapshot(targetPath, snapshot) {
  if (!snapshot) return;

  try {
    const resolved = resolveHudStatePath(targetPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    };

    writeJsonAtomic(resolved, payload);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to write HUD snapshot: ${msg}`);
  }
}

function resolveHudRefreshPath(targetPath) {
  if (!targetPath) return DEFAULT_HUD_REFRESH_PATH;
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(process.cwd(), targetPath);
}

function parseRequestTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Read a HUD refresh request payload from disk.
 *
 * @param {string|null} targetPath
 * @returns {{requestedAt:number|null,reason:string|null,wallets:string[]|null}|null}
 */
function readHudRefreshRequest(targetPath) {
  if (!targetPath) return null;
  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const payload = JSON.parse(raw);
    const requestedAt = parseRequestTimestamp(payload?.requestedAt);
    return {
      requestedAt,
      reason: payload?.reason ? String(payload.reason) : null,
      wallets: Array.isArray(payload?.wallets) ? payload.wallets : null,
    };
  } catch {
    return null;
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
    fs.writeFileSync(
      WARCHEST_PID_FILE,
      JSON.stringify(payload, null, 2),
      "utf8"
    );
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

// HUD rendering lives in lib/warchest/workers/warchestHudWorker.js (this worker only writes snapshots).

// ---------- env helpers ----------
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HUD_SOL_REFRESH_SEC = intFromEnv("HUD_SOL_REFRESH_SEC", 15);
const HUD_TOKENS_REFRESH_SEC = intFromEnv("HUD_TOKENS_REFRESH_SEC", 30);
const HUD_MAX_TX = intFromEnv("WARCHEST_HUD_MAX_TX", 10);
const HUD_MAX_LOGS = intFromEnv("WARCHEST_HUD_MAX_LOGS", 5);
const WARCHEST_HUD_EMIT_THROTTLE_MS = intFromEnv(
  "WARCHEST_HUD_EMIT_THROTTLE_MS",
  100
);
const WARCHEST_LOG_REFRESH_DEBOUNCE_MS = intFromEnv(
  "WARCHEST_LOG_REFRESH_DEBOUNCE_MS",
  750
);
const WARCHEST_WS_STALE_MS = intFromEnv("WARCHEST_WS_STALE_MS", 20_000);
const WARCHEST_WS_RESTART_GAP_MS = intFromEnv(
  "WARCHEST_WS_RESTART_GAP_MS",
  30_000
);
const WARCHEST_WS_RESTART_MAX_BACKOFF_MS = intFromEnv(
  "WARCHEST_WS_RESTART_MAX_BACKOFF_MS",
  5 * 60_000
);
const WARCHEST_WS_UNSUB_TIMEOUT_MS = intFromEnv(
  "WARCHEST_WS_UNSUB_TIMEOUT_MS",
  2500
);

const TOKEN_PROGRAM_LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_PROGRAM_22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// SOL wrapped mint for pricing (SolanaTracker Data API)
const SOL_MINT = "So11111111111111111111111111111111111111112";

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
  logger: dataLogger,
});


// Toggle set by the token refresh timer: when true, we do an expensive full-meta refresh.
// When false, we do a cheap batch price refresh.
let hudMetaRefreshTick = false;


// ---------- SellOps state (streamed from sellOpsWorker children) ----------

// ---------- HUD state ----------
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
 * @property {object|null} sellOps - Latest SellOps evaluation payload (recommendation, decision, worstSeverity, reasons, riskControls, headline, details, metricsLine).
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
 * @property {number|null} liveSolLamports
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
      liveSolLamports: null,
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

/**
 * Record a short activity line for the HUD log view.
 *
 * @param {WalletState} wallet
 * @param {string} summary
 * @param {{emitChange: Function}|null} hudStore
 */
function pushRecentEvent(wallet, summary, hudStore) {
  if (!wallet.recentEvents) wallet.recentEvents = [];
  wallet.recentEvents.unshift({ ts: Date.now(), summary });
  if (wallet.recentEvents.length > HUD_MAX_LOGS) {
    wallet.recentEvents.length = HUD_MAX_LOGS;
  }
  if (hudStore) hudStore.emitChange();
}

/**
 * Normalize event price change deltas.
 *
 * @param {object} eventsObj
 * @returns {object|null}
 */

// ---------- helpers for SOL balance refresh ----------

/**
 * Fetch the SOL balance for a single wallet via RPC methods helper.
 *
 * @param {*} rpcMethods
 * @param {string} pubkey
 * @returns {Promise<number|null>} balance in SOL or null on error
 */
async function fetchSolBalance(rpcMethods, pubkey) {
  if (!rpcMethods || typeof rpcMethods.getSolBalance !== "function")
    return null;
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
      w.liveSolLamports = lamportsApprox;

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
  if (
    !rpcMethods ||
    !wallet ||
    typeof rpcMethods.getTokenAccountsByOwnerV2 !== "function"
  ) {
    return;
  }

  const mode = opts && opts.mode === "meta" ? "meta" : "price";
  const doMeta = mode === "meta";

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
      logger.warn(
        `[HUD] Token-22 pagination incomplete for ${wallet.alias}; balances may be partial.`
      );
    }

    const resLegacy = await fetchAllTokenAccounts(rpcMethods, wallet.pubkey, {
      programId: TOKEN_PROGRAM_LEGACY,
      limit: 500,
      excludeZero: true,
      pageLimit: 20,
    });
    const accountsLegacy = Array.isArray(resLegacy?.accounts)
      ? resLegacy.accounts
      : [];
    if (accountsLegacy.length > 0) {
      allAccounts.push(...accountsLegacy);
    }
    if (resLegacy?.truncated) {
      logger.warn(
        `[HUD] Legacy token pagination incomplete for ${wallet.alias}; balances may be partial.`
      );
    }

    const aggregated = new Map();
    for (const account of allAccounts) {
      const mint = account?.mint;
      if (!mint) continue;
      const amount =
        typeof account.uiAmount === "number"
          ? account.uiAmount
          : Number(account.uiAmount);
      if (!Number.isFinite(amount)) continue;
      aggregated.set(mint, (aggregated.get(mint) || 0) + amount);
    }

    // META ticks: fetch wallet token metadata in one call (instead of per-mint ensureTokenInfo).
    // This payload mirrors the single-token contract but is wrapped in { tokens: [...] }.
    const walletTokenMetaByMint = new Map();
    if (
      doMeta &&
      dataClient &&
      typeof dataClient.getWalletTokens === "function"
    ) {
      try {
        const metaStart = Date.now();
        const walletMetaResp = await dataClient.getWalletTokens({
          wallet: wallet.pubkey,
        });
        rpcStats.lastDataApiMs = Date.now() - metaStart;

        const rows =
          walletMetaResp && Array.isArray(walletMetaResp.tokens)
            ? walletMetaResp.tokens
            : [];
        for (const row of rows) {
          const mint =
            row?.token?.mint || row?.token?.address || row?.mint || null;
          if (!mint) continue;
          walletTokenMetaByMint.set(mint, row);
        }

        // Persist coin metadata/stats into BootyBox (ignores wallet-specific balance/value).
        if (rows.length > 0 && typeof upsertTokenInfoPayload === "function") {
          await upsertTokenInfoPayload(walletMetaResp);
        }

        wallet.lastMetaRefreshAt = Date.now();
      } catch (metaErr) {
        const msg = metaErr && metaErr.message ? metaErr.message : metaErr;
        logger.error(
          `[HUD] Failed to fetch wallet token metadata for ${wallet.alias} ${wallet.pubkey} - ${msg}`
        );
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
        typeof dataClient.getMultipleTokenPrices === "function"
      ) {
        try {
          // API expects an array of mints.
          const priceStart = Date.now();
          const resp = await dataClient.getMultipleTokenPrices({
            mints,
          });
          rpcStats.lastDataApiMs = Date.now() - priceStart;

          if (resp && typeof resp === "object") {
            for (const [mintKey, info] of Object.entries(resp)) {
              if (!info || typeof info !== "object") continue;
              const price = typeof info.price === "number" ? info.price : null;
              if (price != null && Number.isFinite(price)) {
                pricesByMint[mintKey] = price;
              }
            }

            // Update global SOL price if present.
            if (
              Object.prototype.hasOwnProperty.call(pricesByMint, SOL_MINT) &&
              typeof pricesByMint[SOL_MINT] === "number"
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
      const tokenMeta = doMeta ? walletTokenMetaByMint.get(mint) || null : null;

      let symbol = "";
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

        if (typeof tokenLike.decimals === "number") {
          decimals = tokenLike.decimals;
        }
      }

      // Fallback to prior values for symbol/decimals if not found
      const prev = prevByMint.get(mint) || null;
      // Preserve symbol and decimals if previously non-empty, and avoid overwriting with empty values
      if ((!symbol || symbol === "") && prev && prev.symbol)
        symbol = prev.symbol;
      if (
        (decimals == null || decimals === "") &&
        prev &&
        typeof prev.decimals === "number"
      )
        decimals = prev.decimals;

      // Optional debug: see what we're getting if symbol is still empty
      if (!symbol && tokenMeta && process.env.HUD_DEBUG_METADATA === "1") {
        // eslint-disable-next-line no-console
        logger.debug("[HUD] tokenMeta had no symbol", { mint, tokenMeta });
      }

      // Best-effort: derive richer market metrics from tokenMeta (available on META ticks).
      const metaMapped = tokenMeta ? mapCoinMeta(tokenMeta) : null;

      // priceUsd: prefer batched price ticks; fall back to tokenMeta pool price; fall back to prior.
      const priceUsdFromBatch = pricesByMint[mint];
      const priceUsd =
        priceUsdFromBatch != null && Number.isFinite(priceUsdFromBatch)
          ? priceUsdFromBatch
          : metaMapped && typeof metaMapped.priceUsd === "number"
          ? metaMapped.priceUsd
          : prev && typeof prev.priceUsd === "number"
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
      const pools =
        tokenMeta && Array.isArray(tokenMeta.pools) ? tokenMeta.pools : [];
      const primaryPool = pickPrimaryPool(pools);

      // Compute curve and risk fields
      const curvePct = tokenMeta
        ? extractCurvePct(pools)
        : prev && typeof prev.curvePct === "number"
        ? prev.curvePct
        : null;
      const { riskScore, top10Pct, sniperPct, devPct, riskTags } = tokenMeta
        ? extractRiskFields(tokenMeta)
        : {
            riskScore:
              prev && typeof prev.riskScore === "number"
                ? prev.riskScore
                : null,
            top10Pct:
              prev && typeof prev.top10Pct === "number" ? prev.top10Pct : null,
            sniperPct:
              prev && typeof prev.sniperPct === "number"
                ? prev.sniperPct
                : null,
            devPct:
              prev && typeof prev.devPct === "number" ? prev.devPct : null,
            riskTags:
              prev && Array.isArray(prev.riskTags) ? prev.riskTags : null,
          };

      const liquidityUsd = (() => {
        if (!primaryPool)
          return prev && typeof prev.liquidityUsd === "number"
            ? prev.liquidityUsd
            : null;
        const liq = primaryPool.liquidity;
        const v =
          (liq && typeof liq.usd === "number" ? liq.usd : null) ??
          (typeof primaryPool.liquidityUsd === "number"
            ? primaryPool.liquidityUsd
            : null) ??
          (typeof primaryPool.liquidity === "number"
            ? primaryPool.liquidity
            : null);
        return Number.isFinite(Number(v))
          ? Number(v)
          : prev && typeof prev.liquidityUsd === "number"
          ? prev.liquidityUsd
          : null;
      })();

      const marketCapUsd = (() => {
        if (!primaryPool)
          return prev && typeof prev.marketCapUsd === "number"
            ? prev.marketCapUsd
            : null;
        const mc = primaryPool.marketCap;
        const v =
          (mc && typeof mc.usd === "number" ? mc.usd : null) ??
          (typeof primaryPool.marketCapUsd === "number"
            ? primaryPool.marketCapUsd
            : null) ??
          (typeof primaryPool.marketCap === "number"
            ? primaryPool.marketCap
            : null);
        return Number.isFinite(Number(v))
          ? Number(v)
          : prev && typeof prev.marketCapUsd === "number"
          ? prev.marketCapUsd
          : null;
      })();

      // Compute usdEstimate from priceUsd, preserving prior estimate during META ticks
      const usdEstimate =
        priceUsd != null && Number.isFinite(priceUsd)
          ? priceUsd * balance
          : prev && typeof prev.usdEstimate === "number"
          ? prev.usdEstimate
          : null;

      // Position snapshot (from sc_pnl_positions_live) to help the HUD show "up/down" per token.
      const pnl = wallet && wallet.pnlByMint ? wallet.pnlByMint[mint] : null;
      const entryUsd = pnl ? toNum(pnl.entryUsd ?? pnl.entry_usd) : null;
      const currentUsd = pnl ? toNum(pnl.currentUsd ?? pnl.current_usd) : null;
      const unrealizedPnlUsd = pnl
        ? toNum(pnl.uPnlUsd ?? pnl.unrealizedPnlUsd ?? pnl.unrealized_pnl_usd)
        : null;
      const realizedPnlUsd = pnl
        ? toNum(pnl.rPnlUsd ?? pnl.realizedPnlUsd ?? pnl.realized_pnl_usd)
        : null;

      const avgEntryUsd =
        entryUsd != null && Number.isFinite(entryUsd) ? entryUsd : null;

      const avgEntryPriceUsd =
        avgEntryUsd != null && Number.isFinite(avgEntryUsd) && balance > 0
          ? avgEntryUsd / balance
          : null;

      // ROI%: prefer view-provided value if present; else compute from entry/current.
      const roiPctFromView = pnl
        ? toNum(pnl.roiPct ?? pnl.roi_pct ?? pnl.roi_percent ?? pnl.roiPercent)
        : null;

      const roiPct =
        roiPctFromView != null
          ? roiPctFromView
          : entryUsd != null && currentUsd != null && entryUsd !== 0
          ? ((currentUsd - entryUsd) / entryUsd) * 100
          : null;

      const position =
        entryUsd != null ||
        currentUsd != null ||
        unrealizedPnlUsd != null ||
        realizedPnlUsd != null
          ? {
              entryUsd,
              currentUsd,
              unrealizedPnlUsd,
              realizedPnlUsd,
              roiPct,
              avgEntryUsd,
              avgEntryPriceUsd,
            }
          : prev && prev.position
          ? prev.position
          : null;

      // Compact line for HUD: show ONLY ROI% (uPnL dollars are already displayed elsewhere).
      const positionLine = (() => {
        const p = position;
        if (!p) return prev && prev.positionLine ? prev.positionLine : null;
        const pct = p.roiPct;
        const pctText =
          pct != null && Number.isFinite(pct)
            ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`
            : null;
        return (
          pctText || (prev && prev.positionLine ? prev.positionLine : null)
        );
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
    logger.error(
      `[HUD] Failed to fetch tokens for ${wallet.alias} ${wallet.pubkey} - ${msg}`
    );
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
  if (
    !rpcMethods ||
    typeof rpcMethods.getTokenAccountsByOwnerV2 !== "function" ||
    aliases.length === 0
  ) {
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

/**
 * Normalize numeric values, especially from DB or API rows.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNum(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a PnL row to provide consistent camelCase and snake_case fields and computed values.
 *
 * @param {object} row
 * @returns {object}
 */
function normalizePnlRow(row) {
  if (!row || typeof row !== "object") return row;

  // Common numeric fields we might use/emit.
  const currentTokenAmount = toNum(
    row.current_token_amount ??
      row.currentTokenAmount ??
      row.token_amount ??
      row.tokenAmount
  );

  // sc_pnl_positions_live fields (preferred in the HUD)
  const avgCostUsd = toNum(
    row.avg_cost_usd ?? row.avgCostUsd ?? row.avg_cost ?? row.avgCost
  );
  const coinPriceUsd = toNum(
    row.coin_price_usd ?? row.coinPriceUsd ?? row.price_usd ?? row.priceUsd
  );
  const unrealizedUsdFromView = toNum(
    row.unrealized_usd ??
      row.unrealizedUsd ??
      row.unrealized_pnl_usd ??
      row.unrealizedPnlUsd
  );
  const realizedUsdFromView = toNum(
    row.realized_usd ??
      row.realizedUsd ??
      row.realized_pnl_usd ??
      row.realizedPnlUsd
  );

  const entryUsdRaw = toNum(
    row.entry_usd ??
      row.entryUsd ??
      row.entry_value_usd ??
      row.entryValueUsd ??
      row.cost_basis_usd ??
      row.costBasisUsd
  );

  // If the view provides avg_cost_usd (cost per token), derive entry value as avg_cost_usd * current amount.
  const entryUsd =
    entryUsdRaw != null
      ? entryUsdRaw
      : avgCostUsd != null && currentTokenAmount != null
      ? avgCostUsd * currentTokenAmount
      : null;

  const currentUsdRaw = toNum(
    row.current_usd ??
      row.currentUsd ??
      row.current_value_usd ??
      row.currentValueUsd ??
      row.value_usd ??
      row.valueUsd
  );

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
      ? (coinPriceUsd / avgCostUsd - 1) * 100
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
    const rows = await BootyBox.getPnlPositionsLive({
      walletId: wallet.walletId,
    });
    const byMint = {};
    for (const row of rows || []) {
      const mint = row && (row.coin_mint || row.coinMint || row.mint);
      if (!mint) continue;

      // Live-only: ignore closed/empty positions.
      const normalized = normalizePnlRow(row);
      const amt = toNum(
        normalized.current_token_amount ?? normalized.currentTokenAmount
      );
      if (!(amt > 0)) continue;

      byMint[mint] = normalized;
    }
    wallet.pnlByMint = byMint;
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(
      `[HUD] Failed to refresh live PnL positions for ${wallet.alias}: ${msg}`
    );
  }
}

/**
 * Create a per-wallet refresh scheduler so log events can immediately refresh token rows.
 *
 * @param {object} deps
 * @param {Record<string,WalletState>} deps.state
 * @param {Function} deps.getRpcMethods
 * @param {Function} deps.emitHudChange
 * @param {Function} [deps.refreshTokenBalances]
 * @param {Function} [deps.refreshPnlPositions]
 * @returns {(alias: string, reason?: string) => void}
 */
function createWalletTokenRefreshScheduler({
  state,
  getRpcMethods,
  emitHudChange,
  refreshTokenBalances,
  refreshPnlPositions,
}) {
  const entries = new Map();
  const refreshBalances =
    typeof refreshTokenBalances === "function"
      ? refreshTokenBalances
      : refreshTokenBalancesForWallet;
  const refreshPositions =
    typeof refreshPnlPositions === "function"
      ? refreshPnlPositions
      : refreshPnlPositionsForWallet;

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
      const rpcMethods =
        typeof getRpcMethods === "function" ? getRpcMethods() : null;
      try {
        await refreshBalances(rpcMethods, wallet, { mode: "price" });
        await refreshPositions(wallet);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(
          `[HUD] Fast token refresh failed for ${wallet.alias}: ${msg}`
        );
      } finally {
        entry.inFlight = false;
        if (typeof emitHudChange === "function") emitHudChange();
        if (entry.pending) {
          entry.pending = false;
          schedule(alias, entry.lastReason || "pending");
        }
      }
    }, WARCHEST_LOG_REFRESH_DEBOUNCE_MS);
  };

  return schedule;
}

async function main() {
  const { wallets, mode, hudStatePath } = parseArgs(process.argv, logger);

  if (mode === "hud") {
    process.env.SC_HUD_MODE = "1";
    process.env.WARCHEST_HUD = "1";
  }

  if (!wallets || wallets.length === 0) {
    logger.error("[HUD] No wallets provided. Use --wallet alias:pubkey:color");
    process.exit(1);
  }

  const bootyReady = await ensureBootyBoxReady();
  if (!bootyReady) {
    logger.error(
      "[HUD] Exiting because BootyBox is unavailable for persistence."
    );
    process.exit(1);
  }

  try {
    const walletsForKeys = typeof BootyBox.listWarchestWallets === "function"
      ? BootyBox.listWarchestWallets()
      : [];
    const needsKeychain = (walletsForKeys || []).some((wallet) => {
      const source = String(wallet?.keySource || wallet?.key_source || "").toLowerCase();
      return wallet?.hasPrivateKey && (source === "keychain" || source === "db_encrypted");
    });
    if (needsKeychain) {
      await primeMasterKey();
      logger.info("[HUD] Keychain master key cached for signing wallets.");
    }
  } catch (err) {
    logger.warn(`[HUD] Keychain preload failed: ${err?.message || err}`);
  }
  try {
    const pruned = await pruneTargetsWithVectorStoreCleanup({
      staleMs: 2 * 60 * 60 * 1000,
      archivedTtlMs: 7 * 24 * 60 * 60 * 1000,
      logger,
    });
    if (pruned) {
      logger.info(`[HUD] Pruned ${pruned} stale targets.`);
    }
  } catch (err) {
    logger.warn(
      `[HUD] Failed to prune targets on startup: ${err?.message || err}`
    );
  }

  let hudStore = null;
  let emitHudChange = () => {};
  let sellOpsOrchestrator = null;
  let buyOpsWorkerHandle = null;
  let buyOpsLastHeartbeatAt = 0;
  let buyOpsLastLoggedAt = 0;
  let buyOpsStarted = false;
  let buyOpsStartedAt = 0;
  let buyOpsRestartedAt = 0;
  let targetOpsWorkerHandle = null;
  let targetOpsLastHeartbeatAt = 0;
  let targetOpsLastLoggedAt = 0;
  let targetOpsStarted = false;
  let targetOpsStartedAt = 0;
  let targetOpsRestartedAt = 0;
  const sellOpsRestartedAtByWallet = new Map();
  let sessionManager = null;
  let sessionState = null;
  const shutdownCoordinator = createShutdownCoordinator({
    logger,
    label: "warchestService",
  });
  let shutdownPromise = null;

  const resolvedWallets = await resolveWalletSpecsWithRegistry(
    wallets,
    BootyBox
  );
  if (!resolvedWallets.length) {
    logger.error(
      "[HUD] Exiting because no wallets could be resolved against sc_wallets."
    );
    process.exit(1);
  }

  const serviceStartedAt = Date.now();
  const walletIdentifiers = resolvedWallets
    .map(
      (wallet) =>
        wallet.alias ||
        wallet.walletAlias ||
        wallet.walletAddress ||
        wallet.wallet ||
        wallet.pubkey ||
        null
    )
    .filter(Boolean);
  reportServiceMetric("start", {
    mode,
    walletCount: resolvedWallets.length,
    wallets: walletIdentifiers.slice(0, 10),
  });

  if (resolvedWallets.length !== wallets.length) {
    logger.warn(
      `[HUD] Resolved ${resolvedWallets.length}/${wallets.length} wallets; unresolved entries will not be persisted.`
    );
  }

  logger.info(`[HUD] Starting warchest service in ${mode} mode.`);

  const state = buildInitialState(resolvedWallets);
  const serviceAlerts = [];

  const wsSupervisor = createWsSupervisor({
    staleAfterMs: WARCHEST_WS_STALE_MS,
    minRestartGapMs: WARCHEST_WS_RESTART_GAP_MS,
    maxBackoffMs: WARCHEST_WS_RESTART_MAX_BACKOFF_MS,
  });

  const resolvedHudStatePath = resolveHudStatePath(hudStatePath);
  const resolvedHudRefreshPath = resolveHudRefreshPath(null);
  let lastHudRefreshRequestAt = 0;
  let hudRefreshInFlight = false;

  const buildHudSnapshot = () => ({
    state,
    chain: getChainState(),
    lastSolPriceUsd,
    rpcStats: { ...rpcStats },
    hudMaxTx: HUD_MAX_TX,
    hudMaxLogs: HUD_MAX_LOGS,
    service: {
      wsSupervisor: wsSupervisor.getStatus(),
      sockets: rpcSocketRegistry ? rpcSocketRegistry.size : null,
      alerts: serviceAlerts.slice(0, 8),
    },
    sellOps: JSON.parse(
      JSON.stringify(
        sellOpsOrchestrator ? sellOpsOrchestrator.getState() : { byWallet: {} }
      )
    ),
    session:
      sessionState && sessionState.id
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
  });

  emitHudChange = createThrottledEmitter(
    () => writeHudSnapshot(resolvedHudStatePath, buildHudSnapshot()),
    WARCHEST_HUD_EMIT_THROTTLE_MS
  );

  hudStore = {
    emitChange: () => emitHudChange(),
    removeAllListeners: () => {},
  };

  emitHudChange();
  const scheduleWalletTokenRefresh = createWalletTokenRefreshScheduler({
    state,
    getRpcMethods: () => rpcMethods,
    emitHudChange,
  });

  const POSITION_HEAL_TIMEOUT_MS = 120_000;

  function formatPositionHealSummary(result) {
    if (!result || typeof result !== "object") return "no result";
    const positions = result.positions || {};
    const trades = result.trades || {};
    const pnl = result.pnl || {};
    const wallets = result.wallets || 0;

    return (
      `wallets=${wallets} ` +
      `positions(created=${positions.created || 0} updated=${positions.updated || 0} ` +
      `closed=${positions.closed || 0} priceFixed=${positions.priceFixed || 0}) ` +
      `trades(requested=${trades.requested || 0} missing=${trades.missing || 0} ` +
      `inserted=${trades.inserted || 0} skipped=${trades.skipped || 0}) ` +
      `pnl(rebuilt=${pnl.rebuilt || 0})`
    );
  }

  /**
   * Force-refresh HUD snapshot data from RPC + DB.
   *
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async function refreshHudSnapshot(reason) {
    if (shutdownPromise) return;
    const canRefreshTokens =
      rpcMethods &&
      typeof rpcMethods.getTokenAccountsByOwnerV2 === "function";

    const label = reason ? ` (${reason})` : "";
    try {
      await withTimeout(
        (async () => {
          if (canRefreshTokens) {
            await refreshAllSolBalances(rpcMethods, state, hudStore);
            await refreshAllTokenBalances(rpcMethods, state, hudStore, {
              mode: "meta",
            });
          }
          await refreshPnlPositions(state, hudStore);
        })(),
        20_000,
        `hud refresh${label}`
      );
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] HUD refresh failed${label}: ${msg}`);
    }
  }

  /**
   * Process a queued HUD refresh request from disk.
   *
   * @returns {Promise<void>}
   */
  async function maybeHandleHudRefreshRequest() {
    if (shutdownPromise || hudRefreshInFlight) return;
    const req = readHudRefreshRequest(resolvedHudRefreshPath);
    if (!req || !req.requestedAt) return;
    if (req.requestedAt <= lastHudRefreshRequestAt) return;

    lastHudRefreshRequestAt = req.requestedAt;
    hudRefreshInFlight = true;
    try {
      const reasonLabel = req.reason ? ` (${req.reason})` : "";
      pushServiceAlert(
        serviceAlerts,
        "info",
        `HUD refresh requested${reasonLabel}`
      );
      await refreshHudSnapshot(`refresh${reasonLabel}`);
      emitHudChange();
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] HUD refresh request failed: ${msg}`);
    } finally {
      hudRefreshInFlight = false;
    }
  }

  function startPositionHealing(reason) {
    try {
      pushServiceAlert(
        serviceAlerts,
        "info",
        `Position heal started${reason ? ` (${reason})` : ""}`
      );
      emitHudChange();

      const handle = forkWorkerWithPayload(POSITION_HEAL_WORKER_PATH, {
        timeoutMs: POSITION_HEAL_TIMEOUT_MS,
        env: mode === "hud" ? { SC_HUD_MODE: "1" } : undefined,
        payload: {
          wallets: resolvedWallets,
          reason: reason || "startup",
        },
      });

      shutdownCoordinator.trackWorker("positionHealing", handle);

      handle
        .then(async (res) => {
          const result = res && res.result ? res.result : res;
          const summary = formatPositionHealSummary(result);
          logger.info(`[HUD] Position heal complete: ${summary}`);
          pushServiceAlert(
            serviceAlerts,
            "info",
            `Position heal complete: ${summary}`
          );
          emitHudChange();
          await refreshHudSnapshot("position-heal");
        })
        .catch((err) => {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Position heal failed: ${msg}`);
          pushServiceAlert(
            serviceAlerts,
            "error",
            `Position heal failed: ${msg}`
          );
          emitHudChange();
        });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to start position heal: ${msg}`);
      pushServiceAlert(
        serviceAlerts,
        "error",
        `Position heal failed: ${msg}`
      );
      emitHudChange();
    }
  }

  // ---- SellOps workers (one per wallet alias) ----
  const pollIntervalMs = 60_000;
  sellOpsOrchestrator = createSellOpsOrchestrator({
    wallets: resolvedWallets,
    state,
    serviceAlerts,
    hudStore,
    forkWorkerWithPayload,
    pushServiceAlert,
    pushRecentEvent,
    emitHudChange,
    logger,
    registerWorker: (label, handle) =>
      shutdownCoordinator.trackWorker(label, handle),
    hudMaxLogs: HUD_MAX_LOGS,
    dataEndpoint: process.env.WARCHEST_DATA_ENDPOINT || null,
    pollIntervalMs,
    workerPath: path.join(__dirname, "sellOpsWorker.js"),
  });

  sellOpsOrchestrator.start().catch((err) => {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] startSellOpsWorkers failed: ${msg}`);
  });

  startPositionHealing("startup");

  const targetListIntervalMs = parseIntervalMs(
    process.env.WARCHEST_TARGET_LIST_INTERVAL_MS,
    300_000
  );
  const targetScanIntervalMs = parseIntervalMs(
    process.env.WARCHEST_TARGET_SCAN_INTERVAL_MS,
    60_000
  );
  const targetScanConcurrency = Math.max(
    1,
    parseNumber(process.env.WARCHEST_TARGET_SCAN_CONCURRENCY, 8)
  );

  const buyOpsEvalIntervalMs = parseIntervalMs(
    process.env.WARCHEST_BUYOPS_EVAL_INTERVAL_MS,
    60_000
  );
  const buyOpsEvalConcurrency = Math.max(
    1,
    parseNumber(process.env.WARCHEST_BUYOPS_EVAL_CONCURRENCY, 8)
  );
  const buyOpsMinScore = parseNumber(process.env.WARCHEST_BUYOPS_MIN_SCORE, 65);
  const buyOpsEvalTimeoutMs = parseNumber(
    process.env.WARCHEST_BUYOPS_EVAL_TIMEOUT_MS,
    20_000
  );

  const WORKER_HEARTBEAT_STALE_MS = 180_000;
  const WORKER_STARTUP_GRACE_MS = 120_000;
  const WORKER_RESTART_COOLDOWN_MS = 120_000;
  const sellOpsStaleMs = Math.max(
    WORKER_HEARTBEAT_STALE_MS,
    pollIntervalMs * 3
  );

  const onTargetOpsProgress = (msg) => {
    if (!msg || msg.type !== "targetOps:heartbeat") return;
    const hb = msg.payload || {};
    const status = hb.status || "idle";
    const note = hb.note || null;
    const counts = hb.counts || null;
    const mints = hb.mints ?? null;
    const errors = hb.errors ?? null;

    const now = Date.now();
    targetOpsLastHeartbeatAt = now;

    reportServiceMetric("targetOpsHeartbeat", {
      status,
      counts,
      mints,
      errors,
      note,
    });

    const details = [];
    if (counts && typeof counts === "object") {
      details.push(`vol=${counts.volume ?? "n/a"}`);
      details.push(`trend=${counts.trending ?? "n/a"}`);
    }
    if (mints != null) details.push(`mints=${mints}`);
    if (errors != null) details.push(`errors=${errors}`);
    if (note) details.push(note);
    const detailText = details.length ? ` ${details.join(" ")}` : "";

    if (!targetOpsStarted) {
      targetOpsStarted = true;
      targetOpsStartedAt = now;
      targetOpsLastLoggedAt = now;
      logger.info(
        `[HUD] TargetOps worker started status=${status}${detailText}`
      );
      pushServiceAlert(
        serviceAlerts,
        "info",
        `TargetOps worker started status=${status}${detailText}`
      );
      emitHudChange();
      return;
    }

    const shouldLog =
      status !== "alive" || now - targetOpsLastLoggedAt >= 60_000;
    if (shouldLog) {
      targetOpsLastLoggedAt = now;
      logger.info(`[HUD] TargetOps heartbeat status=${status}${detailText}`);
      pushServiceAlert(
        serviceAlerts,
        "info",
        `TargetOps heartbeat status=${status}${detailText}`
      );
      emitHudChange();
    }
  };

  const onBuyOpsProgress = (msg) => {
    if (!msg || msg.type !== "buyOps:heartbeat") return;
    const hb = msg.payload || {};
    const alias = hb.walletAlias || "default";
    const strategyLabel = hb.strategyLabel || "inferred";
    const status = hb.status || "idle";
    const targets = hb.targets ?? "n/a";
    const evaluated = hb.evaluated ?? "n/a";
    const decisions = hb.decisions || {};
    const buy = decisions.buy ?? "n/a";
    const errors = hb.errors ?? "n/a";

    const now = Date.now();
    buyOpsLastHeartbeatAt = now;

    reportServiceMetric("buyOpsHeartbeat", {
      status,
      alias,
      strategyLabel,
      targets,
      evaluated,
      buy,
      errors,
    });

    if (!buyOpsStarted) {
      buyOpsStarted = true;
      buyOpsStartedAt = now;
      buyOpsLastLoggedAt = now;
      logger.info(
        `[HUD] BuyOps worker started (${alias} ${strategyLabel}) status=${status} targets=${targets} ` +
          `evaluated=${evaluated} buy=${buy}`
      );
      pushServiceAlert(
        serviceAlerts,
        "info",
        `BuyOps worker started (${alias} ${strategyLabel}) status=${status} targets=${targets} evaluated=${evaluated} buy=${buy}`
      );
      emitHudChange();
      return;
    }

    if (now - buyOpsLastLoggedAt >= 60_000) {
      buyOpsLastLoggedAt = now;
      logger.info(
        `[HUD] BuyOps heartbeat (${alias} ${strategyLabel}) status=${status} targets=${targets} ` +
          `evaluated=${evaluated} buy=${buy}`
      );
      pushServiceAlert(
        serviceAlerts,
        "info",
        `BuyOps heartbeat (${alias} ${strategyLabel}) status=${status} targets=${targets} evaluated=${evaluated} buy=${buy}`
      );
      emitHudChange();
    }
  };

  function startTargetOpsWorker(reason) {
    if (
      targetOpsWorkerHandle &&
      typeof targetOpsWorkerHandle.stop === "function"
    ) {
      targetOpsWorkerHandle.stop(reason || "restart", { graceMs: 5000 });
    }
    targetOpsStarted = false;
    targetOpsLastHeartbeatAt = 0;
    targetOpsLastLoggedAt = 0;
    targetOpsStartedAt = Date.now();

    try {
      targetOpsWorkerHandle = forkWorkerWithPayload(TARGETOPS_WORKER_PATH, {
        timeoutMs: 0,
        waitForExit: false,
        env: mode === "hud" ? { SC_HUD_MODE: "1" } : undefined,
        payload: {
          targetListIntervalMs,
          targetScanIntervalMs,
          scanConcurrency: targetScanConcurrency,
        },
        onProgress: onTargetOpsProgress,
      });
      shutdownCoordinator.trackWorker("targetOpsWorker", targetOpsWorkerHandle);
      targetOpsWorkerHandle.catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] TargetOps worker failed: ${msg}`);
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to start TargetOps worker: ${msg}`);
      pushServiceAlert(
        serviceAlerts,
        "error",
        `TargetOps worker failed: ${msg}`
      );
    }
  }

  function startBuyOpsWorker(reason) {
    if (buyOpsWorkerHandle && typeof buyOpsWorkerHandle.stop === "function") {
      buyOpsWorkerHandle.stop(reason || "restart", { graceMs: 5000 });
    }
    buyOpsStarted = false;
    buyOpsLastHeartbeatAt = 0;
    buyOpsLastLoggedAt = 0;
    buyOpsStartedAt = Date.now();

    try {
      buyOpsWorkerHandle = forkWorkerWithPayload(BUYOPS_WORKER_PATH, {
        timeoutMs: 0,
        waitForExit: false,
        payload: {
          evaluationIntervalMs: buyOpsEvalIntervalMs,
          evaluationConcurrency: buyOpsEvalConcurrency,
          minScore: buyOpsMinScore,
          evalTimeoutMs: buyOpsEvalTimeoutMs,
        },
        onProgress: onBuyOpsProgress,
      });
      shutdownCoordinator.trackWorker("buyOpsWorker", buyOpsWorkerHandle);
      buyOpsWorkerHandle.catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] BuyOps worker failed: ${msg}`);
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to start BuyOps worker: ${msg}`);
      pushServiceAlert(serviceAlerts, "error", `BuyOps worker failed: ${msg}`);
    }
  }

  startTargetOpsWorker();
  startBuyOpsWorker();

  // Best-effort: run a one-off targetlist immediately on startup so BuyOps has fresh targets.
  // Fire-and-forget so we never slow down HUD/daemon startup.
  Promise.resolve()
    .then(async () => {
      try {
        const hub = getHubCoordinator();
        await hub.runTargetList(
          { runOnce: true, skipTargetScan: true },
          {
            timeoutMs: 60_000,
            env: mode === "hud" ? { SC_HUD_MODE: "1" } : undefined,
          }
        );
        logger.info("[HUD] targetlist bootstrap completed on startup");
      } catch (err) {
        logger.warn(
          `[HUD] targetlist bootstrap failed on startup: ${err?.message || err}`
        );
      } finally {
        try {
          closeHubCoordinator();
        } catch (_) {
          // ignore
        }
      }
    })
    .catch(() => {
      // ignore
    });

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
    if (!rpc || typeof rpc.getBlockTime !== "function") return null;

    const normalizedSlot = Number(slot);
    if (
      blockTimeCache.slot === normalizedSlot &&
      blockTimeCache.blockTimeMs != null
    ) {
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
      wsSupervisor.noteError(err, "rpc.getBlockTime");
      const now = Date.now();
      if (now - lastBlockTimeAlertAt > 60_000) {
        lastBlockTimeAlertAt = now;
        pushServiceAlert(
          serviceAlerts,
          "warn",
          `RPC getBlockTime failed: ${msg}`
        );
        if (hudStore) hudStore.emitChange();
      }
      logger.warn(
        `[HUD] Failed to fetch block time for slot ${normalizedSlot}: ${msg}`
      );
      return null;
    }
  }

  async function fetchSlotAnchor() {
    if (!rpc || typeof rpc.getSlot !== "function")
      return { slot: null, blockTimeMs: null };
    try {
      const slotRes = await rpc.getSlot().send();
      const slotValue =
        slotRes && typeof slotRes.value !== "undefined"
          ? slotRes.value
          : slotRes;
      const slot = Number(
        typeof slotValue === "bigint" ? Number(slotValue) : slotValue
      );
      if (!Number.isFinite(slot) || slot <= 0) {
        return { slot: null, blockTimeMs: null };
      }
      const blockTimeMs = await resolveBlockTimeMs(slot);
      return { slot, blockTimeMs };
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(
        `[HUD] Failed to fetch slot anchor for session start: ${msg}`
      );
      return { slot: null, blockTimeMs: null };
    }
  }

  sessionManager = createSessionManager({
    bootyBox: BootyBox,
    logger,
    getChainState,
    closeLingeringSession,
    statusPath: WARCHEST_STATUS_FILE,
    serviceName: SESSION_SERVICE_NAME,
    serviceInstanceId: SERVICE_INSTANCE_ID,
    fetchSlotAnchor,
    wait,
  });
  sessionState = sessionManager.sessionState;
  sessionFinalizer = async (reason = "clean", overrides = {}) => {
    const row = await sessionManager.finalizeSession(reason, overrides);
    if (hudStore) hudStore.emitChange();
    return row;
  };

  try {
    const closed = sessionManager.closeStaleSession();
    if (closed && closed.closed) {
      logger.warn(
        `[HUD] Closed stale session ${
          closed.session?.session_id ?? "unknown"
        } before starting a new service run.`
      );
    }
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to close stale session on startup: ${msg}`);
  }

  await sessionManager.ensureSessionStarted();

  try {
    warlordAIClient = createWarlordAIClient({
      serviceInstanceId: sessionState.serviceInstanceId || SERVICE_INSTANCE_ID,
      logger,
    });
    if (warlordAIClient) {
      shutdownCoordinator.trackCleanup("warlordAI", () => {
        if (typeof warlordAIClient.close === "function") {
          warlordAIClient.close();
        }
      });
      if (warlordAIClient.pid) {
        logger.info(
          `[HUD] WarlordAI worker started (pid=${warlordAIClient.pid})`
        );
        shutdownCoordinator.trackPid("warlordAI", warlordAIClient.pid, {
          stop: () => warlordAIClient.close(),
        });
      } else {
        logger.info("[HUD] WarlordAI worker started");
      }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[HUD] Failed to start WarlordAI worker: ${msg}`);
    warlordAIClient = null;
  }

  // WalletManagerV2 instances per wallet alias. These are responsible for
  // turning log notifications into trade events and position updates.
  const walletManagers = {};

  resolvedWallets.forEach((w) => {
    if (w.walletId == null) {
      logger.warn(
        `[HUD] Skipping WalletManagerV2 for ${w.alias}; walletId not resolved.`
      );
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
        `[HUD] Failed to initialize WalletManagerV2 for ${w.alias} (${w.pubkey}): ${msg}`
      );
    }
  });

  let slotSub = null;
  const accountSubs = [];
  const logsSubs = [];

  function applyRpcToWalletManagers(nextRpc) {
    if (!nextRpc) return;
    for (const wm of Object.values(walletManagers)) {
      if (wm && typeof wm === "object") {
        // WalletManagerV2 currently does not call this.rpc, but we keep it fresh
        // so future enhancements do not read from a stale RPC client.
        // eslint-disable-next-line no-param-reassign
        wm.rpc = nextRpc;
      }
    }
  }

  async function unsubscribeAllSubs(reason) {
    const label = reason ? `unsubscribe (${reason})` : "unsubscribe";

    if (slotSub && typeof slotSub.unsubscribe === "function") {
      try {
        await withTimeout(
          slotSub.unsubscribe(),
          WARCHEST_WS_UNSUB_TIMEOUT_MS,
          `${label}: slotSub`
        );
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] ${label}: slot unsubscribe failed: ${msg}`);
      }
    }
    slotSub = null;

    try {
      for (const sub of accountSubs.splice(0, accountSubs.length)) {
        if (sub && typeof sub.unsubscribe === "function") {
          try {
            await withTimeout(
              sub.unsubscribe(),
              WARCHEST_WS_UNSUB_TIMEOUT_MS,
              `${label}: accountSub`
            );
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
        if (sub && typeof sub.unsubscribe === "function") {
          try {
            await withTimeout(
              sub.unsubscribe(),
              WARCHEST_WS_UNSUB_TIMEOUT_MS,
              `${label}: logsSub`
            );
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
    if (!wsSupervisor.beginRestart(reason || "restart")) return null;

    if (err) wsSupervisor.noteError(err, reason || "restart");

    const restartReason = reason || "restart";
    pushServiceAlert(
      serviceAlerts,
      "warn",
      `Restarting RPC/WS (${restartReason})`
    );
    if (hudStore) hudStore.emitChange();

    reconnectPromise = (async () => {
      let ok = false;
      try {
        await unsubscribeAllSubs("reconnect");

        if (typeof close === "function") {
          try {
            await withTimeout(
              close(),
              WARCHEST_WS_UNSUB_TIMEOUT_MS,
              "rpcClient.close"
            );
          } catch (closeErr) {
            const msg =
              closeErr && closeErr.message ? closeErr.message : closeErr;
            logger.warn(
              `[HUD] RPC client close timed out/failed during reconnect: ${msg}`
            );
          }
        }

        bindRpcClient(createFreshRpcClient());
        applyRpcToWalletManagers(rpc);

        // Reset cached block time on client restart to avoid coupling to the old transport.
        blockTimeCache.slot = null;
        blockTimeCache.blockTimeMs = null;

        await startSubscriptions();
        ok = true;
        pushServiceAlert(
          serviceAlerts,
          "info",
          `RPC/WS restarted (${restartReason})`
        );
      } catch (restartErr) {
        wsSupervisor.noteError(restartErr, "reconnect");
        const msg =
          restartErr && restartErr.message ? restartErr.message : restartErr;
        pushServiceAlert(
          serviceAlerts,
          "error",
          `RPC/WS restart failed: ${msg}`
        );
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
    if (
      rpcSubs &&
      rpcMethods &&
      typeof rpcMethods.subscribeLogs === "function"
    ) {
      const aliasesForLogs = Object.keys(state);

      for (const alias of aliasesForLogs) {
        const wallet = state[alias];
        try {
          logger.info(
            `[HUD] Subscribing to logs for ${wallet.alias} (${wallet.pubkey}).`
          );
          const sub = await rpcMethods.subscribeLogs(
            { mentions: [wallet.pubkey] },
            (ev) => {
              try {
                const value = ev && (ev.value || ev.result || ev);
                if (!value) return;

                const logs = Array.isArray(value.logs) ? value.logs : [];
                const signature =
                  typeof value.signature === "string" ? value.signature : null;
                const firstLog = logs[0] || "";
                const shortSig = signature
                  ? `${signature.slice(0, 4)}...${signature.slice(-4)}`
                  : "unknown sig";
                const msg = firstLog ? firstLog.slice(0, 60) : "log event";
                const summary = `${new Date().toLocaleTimeString()} ${shortSig} ${msg}`;
                pushRecentEvent(wallet, summary, hudStore);

                const wm = walletManagers[alias];
                if (wm && typeof wm.handleLogNotification === "function") {
                  Promise.resolve(wm.handleLogNotification(ev)).catch(
                    (wmErr) => {
                      const wmsg =
                        wmErr && wmErr.message ? wmErr.message : wmErr;
                      logger.warn(
                        `[HUD] WalletManagerV2 error for ${wallet.alias}: ${wmsg}`
                      );
                    }
                  );
                }

                if (typeof scheduleWalletTokenRefresh === "function") {
                  scheduleWalletTokenRefresh(wallet.alias, "logs");
                }
              } catch (logErr) {
                const msg = logErr && logErr.message ? logErr.message : logErr;
                logger.warn(
                  `[HUD] Error processing logs event for ${wallet.alias}: ${msg}`
                );
              }
            },
            {
              onError: (subErr) => {
                wsSupervisor.noteError(subErr, `logsSub:${wallet.alias}`);
                pushServiceAlert(
                  serviceAlerts,
                  "error",
                  `logsSubscribe error (${wallet.alias}): ${
                    subErr?.message || subErr
                  }`
                );
                if (hudStore) hudStore.emitChange();
                requestReconnect("ws_logs_error", subErr);
              },
            }
          );

          logsSubs.push(sub);
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(
            `[HUD] Failed to subscribe to logs for ${wallet.alias} (${wallet.pubkey}): ${msg}`
          );
        }
      }
    } else if (!rpcSubs) {
      logger.warn("[HUD] Logs subscriptions skipped: rpcSubs not available.");
    } else {
      logger.warn(
        "[HUD] Logs subscriptions skipped: rpcMethods.subscribeLogs is not available."
      );
    }

    logger.info("[HUD] SolanaTracker RPC client initialized.");
    if (!rpcSubs) {
      // eslint-disable-next-line no-console
      logger.warn(
        "[HUD] rpcSubs is null; WS subscriptions are disabled (no SOLANATRACKER_RPC_WS_URL?)."
      );
    }

    if (
      rpcSubs &&
      rpcMethods &&
      typeof rpcMethods.subscribeSlot === "function"
    ) {
      try {
        logger.info("[HUD] Subscribing to slot updates for chain heartbeat.");
        slotSub = await rpcMethods.subscribeSlot(
          (ev) => {
            updateFromSlotEvent(ev);
            if (hudStore) hudStore.emitChange();
          },
          {
            onError: (subErr) => {
              wsSupervisor.noteError(subErr, "slotSub");
              pushServiceAlert(
                serviceAlerts,
                "error",
                `slotSubscribe error: ${subErr?.message || subErr}`
              );
              if (hudStore) hudStore.emitChange();
              requestReconnect("ws_slot_error", subErr);
            },
          }
        );
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        wsSupervisor.noteError(err, "subscribeSlot");
        pushServiceAlert(
          serviceAlerts,
          "error",
          `Failed to subscribe slot updates: ${msg}`
        );
        logger.error(`[HUD] Failed to subscribe to slot updates: ${msg}`);
      }
    } else if (!rpcSubs) {
      logger.warn("[HUD] Slot subscription skipped: rpcSubs not available.");
    } else {
      logger.warn(
        "[HUD] Slot subscription skipped: rpcMethods.subscribeSlot is not available."
      );
    }

    // Live SOL balance updates via accountSubscribe (best-effort).
    if (
      rpcSubs &&
      rpcMethods &&
      typeof rpcMethods.subscribeAccount === "function"
    ) {
      const aliases = Object.keys(state);

      for (const alias of aliases) {
        const wallet = state[alias];
        try {
          logger.info(
            `[HUD] Subscribing to SOL account for ${wallet.alias} (${wallet.pubkey}).`
          );

          const sub = await rpcMethods.subscribeAccount(
            wallet.pubkey,
            (ev) => {
              try {
                const value = ev && (ev.value || ev.account || ev);
                if (!value) return;

                let lamports = null;
                if (typeof value.lamports === "number") {
                  lamports = value.lamports;
                } else if (value.lamports != null) {
                  lamports = Number(value.lamports);
                }

                if (!Number.isFinite(lamports)) return;

                updateSol(wallet.pubkey, lamports);
                wallet.liveSolLamports = lamports;

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
                const msg =
                  updateErr && updateErr.message
                    ? updateErr.message
                    : updateErr;
                logger.warn(
                  `[HUD] Error processing SOL account update for ${wallet.alias}: ${msg}`
                );
              }
            },
            {
              onError: (subErr) => {
                wsSupervisor.noteError(subErr, `accountSub:${wallet.alias}`);
                pushServiceAlert(
                  serviceAlerts,
                  "error",
                  `accountSubscribe error (${wallet.alias}): ${
                    subErr?.message || subErr
                  }`
                );
                if (hudStore) hudStore.emitChange();
                requestReconnect("ws_account_error", subErr);
              },
            }
          );

          accountSubs.push(sub);
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(
            `[HUD] Failed to subscribe to SOL account for ${wallet.alias} (${wallet.pubkey}): ${msg}`
          );
        }
      }
    } else if (!rpcSubs) {
      logger.warn(
        "[HUD] SOL account subscriptions skipped: rpcSubs not available."
      );
    } else {
      logger.warn(
        "[HUD] SOL account subscriptions skipped: rpcMethods.subscribeAccount is not available."
      );
    }
  }

  await startSubscriptions();

  // Initial SOL balance fetch
  await refreshAllSolBalances(rpcMethods, state, hudStore);
  await refreshAllTokenBalances(rpcMethods, state, hudStore, { mode: "meta" });
  await refreshPnlPositions(state, hudStore);

  // Periodic SOL refresh using HTTP RPC
  const solTimer = setInterval(() => {
    refreshAllSolBalances(rpcMethods, state, hudStore).catch((err) => {
      logger.error("[HUD] Error refreshing SOL balances:", err.message || err);
    });
  }, HUD_SOL_REFRESH_SEC * 1000);

  const tokenTimer = setInterval(() => {
    hudMetaRefreshTick = !hudMetaRefreshTick;
    const mode = hudMetaRefreshTick ? "meta" : "price";

    refreshAllTokenBalances(rpcMethods, state, hudStore, { mode }).catch(
      (err) => {
        logger.error(
          "[HUD] Error refreshing token balances:",
          err.message || err
        );
      }
    );
    refreshPnlPositions(state, hudStore).catch((err) => {
      logger.warn(
        "[HUD] Error refreshing live PnL positions:",
        err.message || err
      );
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
        const { shouldRestart, reason } = wsSupervisor.shouldRestartForStale(
          chain?.lastSlotAt ?? null
        );
        if (shouldRestart) {
          pushServiceAlert(
            serviceAlerts,
            "warn",
            `WS heartbeat stale; restarting (${reason})`
          );
          if (hudStore) hudStore.emitChange();
          await reconnectRpcClient(reason);
        }

        const now = Date.now();
        const shouldRestartWorker = (
          lastHeartbeatAt,
          startedAt,
          lastRestartAt,
          staleMs
        ) => {
          if (lastRestartAt && now - lastRestartAt < WORKER_RESTART_COOLDOWN_MS)
            return false;
          if (startedAt && now - startedAt < WORKER_STARTUP_GRACE_MS)
            return false;
          if (!lastHeartbeatAt) {
            if (!startedAt) return false;
            return now - startedAt >= staleMs;
          }
          return now - lastHeartbeatAt >= staleMs;
        };

        if (
          buyOpsWorkerHandle &&
          shouldRestartWorker(
            buyOpsLastHeartbeatAt,
            buyOpsStartedAt,
            buyOpsRestartedAt,
            WORKER_HEARTBEAT_STALE_MS
          )
        ) {
          buyOpsRestartedAt = now;
          logger.warn("[HUD] BuyOps heartbeat stale; restarting worker.");
          pushServiceAlert(
            serviceAlerts,
            "warn",
            "BuyOps heartbeat stale; restarting worker."
          );
          startBuyOpsWorker("watchdog");
        }

        if (
          targetOpsWorkerHandle &&
          shouldRestartWorker(
            targetOpsLastHeartbeatAt,
            targetOpsStartedAt,
            targetOpsRestartedAt,
            WORKER_HEARTBEAT_STALE_MS
          )
        ) {
          targetOpsRestartedAt = now;
          logger.warn("[HUD] TargetOps heartbeat stale; restarting worker.");
          pushServiceAlert(
            serviceAlerts,
            "warn",
            "TargetOps heartbeat stale; restarting worker."
          );
          startTargetOpsWorker("watchdog");
        }

        if (
          sellOpsOrchestrator &&
          typeof sellOpsOrchestrator.restartWallet === "function"
        ) {
          const sellOpsState = sellOpsOrchestrator.getState();
          for (const wallet of resolvedWallets) {
            const alias = wallet?.alias;
            if (!alias) continue;
            const hb = sellOpsState?.byWallet?.[alias]?.heartbeat || null;
            const lastHeartbeatAt =
              hb && Number.isFinite(Number(hb.ts)) ? Number(hb.ts) : 0;
            const lastRestartAt = sellOpsRestartedAtByWallet.get(alias) || 0;
            const startedAt = serviceStartedAt;

            if (
              shouldRestartWorker(
                lastHeartbeatAt,
                startedAt,
                lastRestartAt,
                sellOpsStaleMs
              )
            ) {
              sellOpsRestartedAtByWallet.set(alias, now);
              logger.warn(
                `[HUD] SellOps heartbeat stale (${alias}); restarting worker.`
              );
              pushServiceAlert(
                serviceAlerts,
                "warn",
                `SellOps heartbeat stale (${alias}); restarting worker.`
              );
              sellOpsOrchestrator.restartWallet(alias, "watchdog");
            }
          }
        }

        const health = updateHealth(state, rpcStats, {
          wsSupervisor: wsSupervisor.getStatus(),
          socketCount: rpcSocketRegistry ? rpcSocketRegistry.size : null,
        });
        if (!health || !health.ws) return;

        const slot = Number.isFinite(Number(health.ws.slot))
          ? Math.trunc(Number(health.ws.slot))
          : null;
        let blockTimeMs = null;
        if (slot) {
          blockTimeMs = await resolveBlockTimeMs(slot);
          if (blockTimeMs != null) {
            health.ws.blockTimeMs = blockTimeMs;
          }
        }

        if (
          sessionState.id &&
          slot &&
          typeof BootyBox.updateSessionStats === "function"
        ) {
          try {
            BootyBox.updateSessionStats({
              sessionId: sessionState.id,
              currentSlot: slot,
              currentBlockTime: blockTimeMs,
            });
            sessionState.lastHeartbeatSlot = slot;
            if (blockTimeMs != null)
              sessionState.lastHeartbeatBlockTime = blockTimeMs;
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

          if (mode === "daemon") {
            const rssMb = Math.round(health.process.rssBytes / 1024 / 1024);
            const lagMs = health.process.eventLoopLagMs;
            const socketCount =
              health.service && typeof health.service.sockets === "number"
                ? health.service.sockets
                : null;

            logger.info(
              `[warchest] Health: up=${
                health.process.uptimeSec
              }s rss=${rssMb}MB slot=${health.ws.slot} wsAge=${
                health.ws.lastSlotAgeMs
              }ms lag=${lagMs}ms wallets=${health.wallets.count} sockets=${
                socketCount != null ? socketCount : "n/a"
              }`
            );
          }
        }

        await maybeHandleHudRefreshRequest();
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Health update failed: ${msg}`);
      })
      .finally(() => {
        healthUpdateInFlight = false;
      });
  }, 5000);

  // Graceful shutdown
  async function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      reportServiceMetric("shutdown", {
        durationMs: Date.now() - serviceStartedAt,
        walletCount: resolvedWallets.length,
      });
      clearInterval(solTimer);
      clearInterval(tokenTimer);
      clearInterval(healthTimer);

      const stopReason = reason || "shutdown";
      pushServiceAlert(
        serviceAlerts,
        "warn",
        `Warchest service stopping (${stopReason})`
      );
      try {
        const shutdownSnapshot = buildHudSnapshot();
        shutdownSnapshot.service = {
          ...(shutdownSnapshot.service || {}),
          status: "stopped",
          stoppedAt: new Date().toISOString(),
          stopReason,
        };
        writeHudSnapshot(resolvedHudStatePath, shutdownSnapshot);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to write shutdown HUD snapshot: ${msg}`);
      }

      // Stop SellOps children (best-effort)
      try {
        if (
          sellOpsOrchestrator &&
          typeof sellOpsOrchestrator.stopAll === "function"
        ) {
          sellOpsOrchestrator.stopAll();
        }
      } catch {}

      if (hudStore && typeof hudStore.removeAllListeners === "function") {
        hudStore.removeAllListeners();
      }

      try {
        await shutdownCoordinator.shutdown(reason || "shutdown", {
          graceMs: 5_000,
          waitMs: 8_000,
          forceWaitMs: 2_000,
          forceSignal: "SIGKILL",
        });
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Shutdown coordinator failed: ${msg}`);
      }

      try {
        await unsubscribeAllSubs("shutdown");
        if (typeof close === "function") {
          await close();
        }
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Error during RPC client close: ${msg}`);
      }

      try {
        if (typeof sessionFinalizer === "function") {
          await sessionFinalizer("clean");
        }
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to finalize session on shutdown: ${msg}`);
      } finally {
        removePidFile();
        process.exit(0);
      }
    })();

    return shutdownPromise;
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = {
  buildInitialState,
  pushRecentEvent,
  fetchSolBalance,
  refreshAllSolBalances,
  refreshPnlPositions,
  toNum,
  normalizePnlRow,
  createWalletTokenRefreshScheduler,
  refreshPnlPositionsForWallet,
};

// Run if invoked directly
if (require.main === module) {
  main().catch(async (err) => {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Fatal error: ${msg}`);
    try {
      if (warlordAIClient && typeof warlordAIClient.close === "function") {
        warlordAIClient.close();
      }
    } catch {}
    if (typeof sessionFinalizer === "function") {
      try {
        await sessionFinalizer("crash");
      } catch (finalErr) {
        const finalMsg =
          finalErr && finalErr.message ? finalErr.message : finalErr;
        logger.warn(
          `[HUD] Failed to finalize session after crash: ${finalMsg}`
        );
      }
    }
    removePidFile();
    process.exit(1);
  });
}
