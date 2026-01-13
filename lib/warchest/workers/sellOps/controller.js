"use strict";

const path = require("path");

const logger = require("../../../logger");
const BootyBox = require("../../../../db/src/adapters/sqlite");
const { setup } = require("../../client");
const {
  createSolanaTrackerDataClient,
} = require("../../../solanaTrackerDataClient");
const { computeMarketRegime } = require("../../../analysis/indicators");
const {
  buildEvaluation,
} = require("../../../../db/src/services/evaluationService");
const { forkWorkerWithPayload } = require("../harness");
const { getHubCoordinator } = require("../../hub");
const { loadStrategyDocs } = require("./strategyDocs");
const {
  evaluatePosition,
  DEFAULT_EVENT_INTERVALS,
} = require("./evaluationEngine");
const { normalizeWallet, toPositionSummary } = require("./positionAdapter");
const { buildHudPayload, emitToParent } = require("./hudPublisher");
const { persistSellOpsEvaluation } = require("./persistence");
const {
  resolveAvgCostUsd,
  getTrailingStopConfig,
} = require("./stopLogicLoader");

const DEFAULT_POLL_MS = 60_000;
const MAX_PRICE_STALE_MS = 15_000;

function fmtUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "n/a";
  const sign = x < 0 ? "-" : "";
  const abs = Math.abs(x);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(n, digits = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "n/a";
  return `${x.toFixed(digits)}%`;
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function summarizeStrategyLabel(input) {
  const names = new Set();
  const add = (item) => {
    if (!item) return;
    const name = item.strategyName || item.strategyId || null;
    if (!name) return;
    const trimmed = String(name).trim();
    if (trimmed) names.add(trimmed);
  };

  if (Array.isArray(input)) {
    input.forEach(add);
  } else if (input && typeof input.values === "function") {
    for (const item of input.values()) add(item);
  } else if (input) {
    add(input);
  }

  const list = Array.from(names);
  if (!list.length) return "none";
  if (list.length === 1) return list[0];
  const max = 3;
  const head = list.slice(0, max).join(",");
  return list.length > max
    ? `multi(${head}+${list.length - max})`
    : `multi(${head})`;
}

function pickTopGateFailures(evaluation, limit = 3) {
  const results = evaluation?.qualify?.results;
  if (!Array.isArray(results) || !results.length) return [];
  const failed = results.filter((r) => r && r.outcome === "fail");
  if (!failed.length) return [];
  return failed.slice(0, limit).map((r) => {
    const id = r.id || "gate?";
    const sev = r.severityOnFail || "fail";
    const reason =
      Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join("; ") : "";
    return { id, severity: sev, reason };
  });
}

function buildFriendlyEvaluationSummary(snapshot) {
  const ev = snapshot?.evaluation || {};
  const sym =
    ev.symbol || (snapshot?.mint ? String(snapshot.mint).slice(0, 4) : "token");
  const rec = ev.recommendation || "hold";
  const strategy = ev?.strategy?.name || "n/a";
  const worst = ev?.qualify?.worstSeverity || "none";
  const warningsCount = Array.isArray(ev.warnings) ? ev.warnings.length : 0;

  const priceUsd = ev?.coin?.priceUsd ?? ev?.coin?.price_usd;
  const liqUsd = ev?.pool?.liquidity_usd || ev?.coin?.liquidityUsd;
  const unrealUsd = ev?.pnl?.unrealized_usd;
  const totalUsd = ev?.pnl?.total_usd;
  const roiPct = ev?.derived?.roiUnrealizedPct;

  const gateFails = pickTopGateFailures(ev, 3);

  // Headline: what you care about at a glance
  const headline =
    `${sym} | ${fmtPct(roiPct)} uPnL=${fmtUsd(unrealUsd)} ` +
    `| rec=${String(rec).toUpperCase()} (${worst})`;

  // Details: the "why"
  const whyParts = [];
  if (gateFails.length) {
    for (const g of gateFails) {
      whyParts.push(`${g.id}:${g.severity}${g.reason ? ` (${g.reason})` : ""}`);
    }
  } else {
    whyParts.push("no gate failures");
  }
  if (warningsCount) whyParts.push(`warnings=${warningsCount}`);
  if (strategy && strategy !== "n/a") whyParts.push(`strategy=${strategy}`);

  // Risk controls (hard stop / trailing stop)
  const rc = snapshot?.riskControls || null;
  if (rc && Number.isFinite(Number(rc.hardStopLossPct))) {
    const hs = Math.abs(Number(rc.hardStopLossPct));
    const dist = Number.isFinite(Number(rc.stopLossDistancePct))
      ? Number(rc.stopLossDistancePct)
      : null;

    if (rc.stopLossEligible) {
      whyParts.unshift(`HARD STOP HIT (-${hs}%)`);
    } else if (dist != null) {
      // Only surface "armed" when we're getting close (within 5%)
      if (dist <= 5)
        whyParts.unshift(`hardStop -${hs}% (${fmtPct(dist, 2)} away)`);
    } else {
      whyParts.unshift(`hardStop -${hs}%`);
    }
  }

  if (rc && rc.trailing && typeof rc.trailing === "object") {
    const t = rc.trailing;
    if (
      t.active &&
      Number.isFinite(Number(t.stopUsd)) &&
      Number.isFinite(Number(t.priceUsd))
    ) {
      const distUsd = Number(t.priceUsd) - Number(t.stopUsd);
      whyParts.unshift(
        `trail stop ${fmtUsd(t.stopUsd)} (Δ ${fmtUsd(distUsd)})`
      );
    } else if (t.active) {
      whyParts.unshift("trail stop armed");
    }
  }

  const details = whyParts.join(" • ");

  // Metrics: still useful, but secondary
  const metrics =
    `price=${fmtUsd(priceUsd)} liq=${fmtUsd(liqUsd)} total=${fmtUsd(
      totalUsd
    )} ` + `regime=${snapshot?.regime?.status || "n/a"}`;

  return {
    token: sym,
    recommendation: rec,
    worstSeverity: worst,
    warningsCount,
    headline,
    details,
    metrics,
    gateFailures: gateFails,
    numbers: { priceUsd, liqUsd, unrealUsd, totalUsd, roiPct },
    strategy,
  };
}

function computeUsdPerTokenFromTrade(trade) {
  if (!trade || typeof trade !== "object") return null;
  const priceUsd = toPositiveNumber(trade.price_usd_per_token);
  if (priceUsd) return priceUsd;

  const tokenAmountRaw = Number(trade.token_amount);
  const solAmountRaw = Number(trade.sol_amount);
  const solUsdPrice = toPositiveNumber(trade.sol_usd_price);

  if (!Number.isFinite(tokenAmountRaw) || tokenAmountRaw === 0) return null;
  if (!Number.isFinite(solAmountRaw) || !solUsdPrice) return null;
  return (Math.abs(solAmountRaw) * solUsdPrice) / Math.abs(tokenAmountRaw);
}

function computeWeightedAvgUsdFromTrades(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  let totalTokens = 0;
  let totalUsd = 0;
  for (const trade of trades) {
    const tokenAmountRaw = Number(trade?.token_amount);
    const tokenAmount = Number.isFinite(tokenAmountRaw)
      ? Math.abs(tokenAmountRaw)
      : null;
    const priceUsd = computeUsdPerTokenFromTrade(trade);
    if (!tokenAmount || !priceUsd) continue;
    totalTokens += tokenAmount;
    totalUsd += priceUsd * tokenAmount;
  }

  if (totalTokens <= 0) return null;
  return totalUsd / totalTokens;
}

/**
 * @typedef {Object} PositionSummary
 * @property {number|string} positionId
 * @property {number|string} walletId
 * @property {string} walletAlias
 * @property {string} mint
 * @property {string|null} tradeUuid
 * @property {number|string|null} strategyId
 * @property {string|null} strategyName
 * @property {number|null} openAt
 * @property {number|null} closedAt
 * @property {number|null} lastTradeAt
 * @property {number|null} lastUpdatedAt
 * @property {number|null} entryTokenAmount
 * @property {number|null} currentTokenAmount
 * @property {number|null} totalTokensBought
 * @property {number|null} totalTokensSold
 * @property {number|null} entryPriceSol
 * @property {number|null} entryPriceUsd
 * @property {number|null} lastPriceSol
 * @property {number|null} lastPriceUsd
 * @property {string|null} source
 */

/**
 * Backfill missing entry_price_usd values using PnL rollups, trade history, or price API.
 * @param {Object} args
 * @param {any} args.db
 * @param {any} args.dataClient
 * @param {PositionSummary[]} args.positions
 * @param {string} args.walletAlias
 * @param {Object} args.log
 * @returns {Promise<{ attempted: number, updated: number, fromPnl: number, fromTrades: number, fromApi: number }>}
 */
async function backfillEntryPriceUsd({
  db,
  dataClient,
  positions,
  walletAlias,
  log,
}) {
  if (!db || typeof db.prepare !== "function") {
    log?.warn?.(
      "[sellOps] entry_price_usd backfill skipped: db handle missing prepare()"
    );
    return { attempted: 0, updated: 0, fromPnl: 0, fromTrades: 0, fromApi: 0 };
  }

  const missing = Array.isArray(positions)
    ? positions.filter((pos) => {
        const price = toPositiveNumber(pos?.entryPriceUsd);
        return !price;
      })
    : [];

  if (!missing.length) {
    return { attempted: 0, updated: 0, fromPnl: 0, fromTrades: 0, fromApi: 0 };
  }

  const stmtPnl = db.prepare(
    `
    SELECT avg_cost_usd
    FROM sc_pnl_positions_live
    WHERE wallet_id = ?
      AND coin_mint = ?
      AND trade_uuid = ?
    LIMIT 1
  `
  );

  const stmtTrades = db.prepare(
    `
    SELECT token_amount, sol_amount, sol_usd_price, price_usd_per_token
    FROM sc_trades
    WHERE wallet_id = ?
      AND coin_mint = ?
      AND trade_uuid = ?
      AND side = 'buy'
    ORDER BY executed_at ASC
  `
  );

  const stmtUpdate = db.prepare(
    `
    UPDATE sc_positions
    SET
      entry_price_usd = CASE
        WHEN entry_price_usd IS NULL OR entry_price_usd <= 0 THEN @entry_price_usd
        ELSE entry_price_usd
      END,
      last_updated_at = @last_updated_at
    WHERE position_id = @position_id
  `
  );

  let updated = 0;
  let fromPnl = 0;
  let fromTrades = 0;
  let fromApi = 0;
  const now = Date.now();

  const pendingByMint = new Map();

  for (const pos of missing) {
    const walletId = pos?.walletId;
    const tradeUuid = pos?.tradeUuid;
    const mint = pos?.mint;
    const positionId = pos?.positionId;

    if (!walletId || !mint || !tradeUuid || !positionId) {
      continue;
    }

    const pnlRow = stmtPnl.get(walletId, mint, tradeUuid);
    const pnlPrice = toPositiveNumber(pnlRow?.avg_cost_usd);
    if (pnlPrice) {
      stmtUpdate.run({
        position_id: positionId,
        entry_price_usd: pnlPrice,
        last_updated_at: now,
      });
      pos.entryPriceUsd = pnlPrice;
      updated += 1;
      fromPnl += 1;
      continue;
    }

    const trades = stmtTrades.all(walletId, mint, tradeUuid);
    const tradePrice = computeWeightedAvgUsdFromTrades(trades);
    if (tradePrice) {
      stmtUpdate.run({
        position_id: positionId,
        entry_price_usd: tradePrice,
        last_updated_at: now,
      });
      pos.entryPriceUsd = tradePrice;
      updated += 1;
      fromTrades += 1;
      continue;
    }

    if (dataClient && typeof dataClient.getMultipleTokenPrices === "function") {
      if (!pendingByMint.has(mint)) pendingByMint.set(mint, []);
      pendingByMint.get(mint).push(pos);
    }
  }

  if (
    pendingByMint.size > 0 &&
    dataClient &&
    typeof dataClient.getMultipleTokenPrices === "function"
  ) {
    try {
      const priceResp = await dataClient.getMultipleTokenPrices(
        Array.from(pendingByMint.keys())
      );
      for (const [mint, list] of pendingByMint.entries()) {
        const priceUsd = toPositiveNumber(priceResp?.[mint]?.price);
        if (!priceUsd) continue;
        for (const pos of list) {
          if (!pos?.positionId) continue;
          stmtUpdate.run({
            position_id: pos.positionId,
            entry_price_usd: priceUsd,
            last_updated_at: now,
          });
          pos.entryPriceUsd = priceUsd;
          updated += 1;
          fromApi += 1;
        }
      }
    } catch (err) {
      log?.warn?.(
        `[sellOps] entry_price_usd backfill price fetch failed wallet=${walletAlias}: ${
          err?.message || err
        }`
      );
    }
  }

  return { attempted: missing.length, updated, fromPnl, fromTrades, fromApi };
}

// Normalize sellOps logger: supports factory-style (logger.sellOps()) and object-style (logger.sellOps).
// Fall back to the base logger when sellOps scoping is unavailable (tests/mocks).
const sellOpsLogger = (() => {
  if (typeof logger.sellOps === "function") return logger.sellOps();
  if (logger.sellOps) return logger.sellOps;
  return logger;
})();

// Strategy docs are versioned JSON stored in the repo.
// Load once at startup; if a file is missing or invalid JSON, fail fast (so we don't trade blind).
const STRATEGY_DOCS = loadStrategyDocs();
const hub = getHubCoordinator({ attachSignals: false });

/**
 * Run a swap through the hub coordinator and optionally start a tx monitor.
 *
 * @param {Object} payload
 * @param {NodeJS.ProcessEnv} workerEnv
 * @returns {Promise<Object|null>}
 */
async function runSwapWithMonitor(payload, workerEnv) {
  const response = await hub.runSwap(payload, { env: workerEnv, timeoutMs: 0 });
  const result = response && response.result ? response.result : response;
  if (result && result.monitorPayload) {
    try {
      const monitorEnv = { ...workerEnv };
      if (
        result.monitorPayload.rpcEndpoint &&
        !monitorEnv.SOLANATRACKER_RPC_HTTP_URL
      ) {
        monitorEnv.SOLANATRACKER_RPC_HTTP_URL =
          result.monitorPayload.rpcEndpoint;
      }
      const monitorResult = await hub.runTxMonitor(result.monitorPayload, {
        env: monitorEnv,
        timeoutMs: 120_000,
      });
      result.monitor = monitorResult;
    } catch (err) {
      sellOpsLogger.warn(
        `[sellOps] tx monitor failed to start: ${err?.message || err}`
      );
    }
  }
  return result || null;
}

/**
 * Run autopsy for a recently-closed position.
 *
 * NOTE: We intentionally require `wallet.pubkey` and `position.tradeUuid` to avoid
 * producing ambiguous artifacts or running expensive analysis without identity.
 *
 * @param {Object} args
 * @param {PositionSummary} args.position
 * @param {{ alias: string, pubkey: string|null }} args.wallet
 * @param {NodeJS.ProcessEnv} args.workerEnv
 * @param {Function} [args.runAutopsy] - Optional injected autopsy runner (tests).
 * @returns {Promise<any|null>}
 */
async function runAutopsyForClosedPosition({
  position,
  wallet,
  workerEnv,
  runAutopsy,
}) {
  if (!position || !wallet) return null;
  if (!wallet.pubkey) {
    sellOpsLogger.warn(
      `[sellOps] autopsy skipped for ${
        position.mint || "mint?"
      }: missing wallet pubkey`
    );
    return null;
  }
  if (!position.tradeUuid) {
    sellOpsLogger.warn(
      `[sellOps] autopsy skipped for ${
        position.mint || "mint?"
      }: missing trade_uuid`
    );
    return null;
  }

  if (typeof runAutopsy === "function") {
    return runAutopsy({
      walletAddress: wallet.pubkey,
      mint: position.mint,
      walletLabel: wallet.alias,
    });
  }

  const workerPath = path.join(__dirname, "..", "autopsyWorker.js");
  const { result } = await forkWorkerWithPayload(workerPath, {
    payload: {
      walletAddress: wallet.pubkey,
      mint: position.mint,
      walletLabel: wallet.alias,
    },
    env: workerEnv,
    timeoutMs: 0,
  });

  return result || null;
}

/**
 * Create a SellOps controller.
 *
 * Payload contract:
 * - payload.wallet: { alias|walletAlias|name, pubkey? }
 * - payload.pollIntervalMs?: number (defaults to 60s)
 * - payload.statusDir?: optional status dir forwarded to setup()
 * @param {Object} payload
 * @param {Object} [tools]
 * @param {Object} [log]
 * @returns {{ start: Function, stop: Function }}
 */
function createSellOpsController(payload, tools = {}, log = sellOpsLogger) {
  const wallet = normalizeWallet(payload.wallet || payload);
  const pollIntervalMs = payload.pollIntervalMs || DEFAULT_POLL_MS;

  const track = typeof tools.track === "function" ? tools.track : () => {};
  const workerEnv = { ...process.env, ...(tools.env || {}) };
  const sendFn =
    tools.sendFn ||
    (typeof process.send === "function" ? process.send.bind(process) : null);

  // Ensure BootyBox sqlite adapter/context is initialized once per worker process.
  try {
    if (typeof BootyBox.init === "function") BootyBox.init();
  } catch (err) {
    log.warn(`[sellOps] BootyBox.init() failed: ${err?.message || err}`);
  }

  let client = tools.client || null;
  const ownsClient = !client;
  let db = null;
  let dataClient = null;
  let previousOpenPositions = new Map(); // trade_uuid -> position summary

  // Fast decision loop state (DB-backed trailing state)
  const symbolByTradeUuid = new Map(); // tradeUuid -> token symbol (for alerts)
  const decisionActionByTradeUuid = new Map(); // tradeUuid -> last strategy-driven action ts
  const missingCostAlertByTradeUuid = new Map(); // tradeUuid -> last alert ts
  const MISSING_COST_ALERT_DEBOUNCE_MS = 60_000;

  let fastTimer = null;
  let fastRunning = false;
  let lastFastHeartbeatTsMs = 0;
  let entryPriceBackfillDone = false;

  const autopsiedTradeUuids = new Set();

  let stopped = false;
  let stopReason = null;
  let pollTimer = null;
  let stopFn = null;

  const finalPromise = new Promise((resolve, reject) => {
    async function cleanup() {
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      if (fastTimer) {
        clearTimeout(fastTimer);
        fastTimer = null;
      }
      fastRunning = false;

      if (dataClient && typeof dataClient.close === "function") {
        try {
          await dataClient.close();
        } catch (err) {
          log.warn(
            `[sellOps] data client close failed: ${err?.message || err}`
          );
        }
      }

      if (client && ownsClient && typeof client.close === "function") {
        try {
          await client.close();
        } catch (err) {
          log.warn(`[sellOps] client close failed: ${err?.message || err}`);
        }
      }
    }

    async function finish(reason) {
      if (stopped) return;
      stopped = true;
      stopReason = reason || "stopped";

      const result = {
        status: "stopped",
        stopReason,
        walletAlias: wallet.alias,
      };

      await cleanup();
      fastRunning = false;
      resolve(result);
    }

    /**
     * Start a fast decision loop that evaluates open positions and applies hard-stop + trailing-stop using
     * DB-backed state restored from the latest persisted evaluation payload.
     */
    function ensureFastDecisionLoopStarted() {
      if (fastRunning) return;
      fastRunning = true;

      const docsForDefaults = STRATEGY_DOCS?.flash || null;
      const defaults = getTrailingStopConfig(docsForDefaults);

      const basePollMs = Number.isFinite(Number(payload?.trailingPollMs))
        ? Number(payload.trailingPollMs)
        : defaults.pollMs;
      const pollMs = Math.max(1_000, basePollMs);

      const actionDebounceMsDefault = defaults.actionDebounceMs;
      const breachConfirmationsDefault = defaults.breachConfirmations;

      async function fastTick() {
        if (stopped) return;

        try {
          if (
            !dataClient ||
            typeof dataClient.getMultipleTokenPrices !== "function"
          )
            return;

          const now = Date.now();

          // Heartbeat every ~15s
          if (now - lastFastHeartbeatTsMs >= 15_000) {
            lastFastHeartbeatTsMs = now;
            emitToParent(
              "sellOps:heartbeat",
              {
                ts: now,
                walletAlias: wallet.alias,
                status: "fast_tick",
                message: "Fast decision tick running",
                statusLabel: "SellOps: fast tick",
                openPositions: previousOpenPositions.size,
                strategyLabel: summarizeStrategyLabel(previousOpenPositions),
                pollMs,
              },
              sendFn
            );
          }

          // Build mint list for one batched price call
          const mintList = [];
          const seen = new Set();
          for (const pos of previousOpenPositions.values()) {
            if (!pos || !pos.mint || !pos.tradeUuid) continue;
            const amt = Number(pos.currentTokenAmount);
            if (Number.isFinite(amt) && amt <= 0) continue;
            const mint = String(pos.mint).trim();
            if (!mint) continue;
            if (seen.has(mint)) continue;
            seen.add(mint);
            mintList.push(mint);
          }
          if (!mintList.length) return;

          const prices = await dataClient.getMultipleTokenPrices(mintList);

          for (const summary of previousOpenPositions.values()) {
            if (!summary || !summary.mint || !summary.tradeUuid) continue;

            const tradeUuid = summary.tradeUuid;
            const mint = summary.mint;

            // Fresh price guard
            const priceObj = prices && prices[mint] ? prices[mint] : null;
            const priceUsdNow =
              priceObj && Number.isFinite(Number(priceObj.price))
                ? Number(priceObj.price)
                : null;
            const lastUpdated =
              priceObj && Number.isFinite(Number(priceObj.lastUpdated))
                ? Number(priceObj.lastUpdated)
                : null;
            if (!priceUsdNow || priceUsdNow <= 0) continue;
            if (lastUpdated != null && now - lastUpdated > MAX_PRICE_STALE_MS)
              continue;

            // Restore prior trailing state from latest persisted evaluation payload
            let prevTrailing = null;
            try {
              const ctx = BootyBox.getLatestSellOpsDecisionContextByTrade
                ? BootyBox.getLatestSellOpsDecisionContextByTrade(
                    summary.walletId,
                    tradeUuid
                  )
                : null;
              prevTrailing = ctx && ctx.trailing ? ctx.trailing : null;
            } catch (err) {
              sellOpsLogger.warn(
                `[sellOps] decision context fetch failed wallet=${
                  wallet.alias
                } trade_uuid=${tradeUuid} mint=${mint}: ${err?.message || err}`
              );
            }

            // Evaluate in light mode (no candles/ohlcv) so fast loop stays cheap
            const observeOnlyDefault =
              workerEnv.SELL_OPS_OBSERVE_ONLY === "true" ||
              workerEnv.NODE_ENV === "test";
            const enginePayload = {
              ...(payload || {}),
              observeOnly:
                payload?.observeOnly != null
                  ? payload.observeOnly
                  : observeOnlyDefault,
              includeCandles: false,
              includeOhlcv: false,
            };

            let evalResult;
            try {
              evalResult = await evaluatePosition({
                position: summary,
                db,
                dataClient,
                eventIntervals:
                  enginePayload.eventIntervals ||
                  payload.eventIntervals ||
                  DEFAULT_EVENT_INTERVALS,
                payload: enginePayload,
                strategyDocs: STRATEGY_DOCS,
                buildEvaluation,
              });
            } catch (err) {
              sellOpsLogger.warn(
                `[sellOps] fast eval failed wallet=${
                  wallet.alias
                } trade_uuid=${tradeUuid} mint=${mint}: ${err?.message || err}`
              );
              continue;
            }

            const evaluation =
              evalResult && evalResult.evaluation ? evalResult.evaluation : {};
            const inferredSym =
              evaluation?.symbol ||
              evaluation?.coin?.symbol ||
              evaluation?.token?.symbol ||
              summary.symbol ||
              null;
            if (inferredSym)
              symbolByTradeUuid.set(tradeUuid, String(inferredSym));

            const costUsd = resolveAvgCostUsd(summary, evaluation);
            const roiPctNow = evaluation?.derived?.roiUnrealizedPct;

            // Determine stop config by strategy (fallback to flash)
            const stratName =
              evaluation?.strategy?.name || summary.strategyName || "flash";
            const stratKey = String(stratName).trim().toLowerCase();
            const docs =
              STRATEGY_DOCS?.[stratKey] || STRATEGY_DOCS?.flash || null;
            const cfg = getTrailingStopConfig(docs);

            const hardStopLossPct = Number.isFinite(
              Number(payload?.hardStopLossPct)
            )
              ? Number(payload.hardStopLossPct)
              : cfg.hardStopLossPct;
            const hsAbs = Number.isFinite(Number(hardStopLossPct))
              ? Math.abs(Number(hardStopLossPct))
              : null;

            const activationPct =
              prevTrailing &&
              Number.isFinite(Number(prevTrailing.activationPct))
                ? Number(prevTrailing.activationPct)
                : cfg.activationPct;
            const trailPct =
              prevTrailing && Number.isFinite(Number(prevTrailing.trailPct))
                ? Number(prevTrailing.trailPct)
                : cfg.trailPct;
            const breachConfirmations =
              cfg.breachConfirmations || breachConfirmationsDefault;
            const actionDebounceMs =
              cfg.actionDebounceMs || actionDebounceMsDefault;

            const state = {
              active: !!(prevTrailing && prevTrailing.active),
              activationPct,
              trailPct,
              highWaterUsd:
                prevTrailing &&
                Number.isFinite(Number(prevTrailing.highWaterUsd))
                  ? Number(prevTrailing.highWaterUsd)
                  : priceUsdNow,
              stopUsd:
                prevTrailing && Number.isFinite(Number(prevTrailing.stopUsd))
                  ? Number(prevTrailing.stopUsd)
                  : 0,
              breachCount:
                prevTrailing &&
                Number.isFinite(Number(prevTrailing.breachCount))
                  ? Number(prevTrailing.breachCount)
                  : 0,
              lastActionTsMs:
                prevTrailing &&
                Number.isFinite(Number(prevTrailing.lastActionTsMs))
                  ? Number(prevTrailing.lastActionTsMs)
                  : 0,
            };

            // Missing cost basis => cannot arm hard/trailing stops
            if (
              !costUsd ||
              !Number.isFinite(Number(costUsd)) ||
              Number(costUsd) <= 0
            ) {
              const lastAlertTs =
                missingCostAlertByTradeUuid.get(tradeUuid) || 0;
              if (now - lastAlertTs >= MISSING_COST_ALERT_DEBOUNCE_MS) {
                const mintLabel =
                  symbolByTradeUuid.get(tradeUuid) ||
                  inferredSym ||
                  (mint ? mint.slice(0, 4) : "coin");
                emitToParent(
                  "sellOps:alert",
                  {
                    ts: now,
                    walletAlias: wallet.alias,
                    tradeUuid,
                    mint,
                    reason: "missing_entry_price_usd",
                    message: `${mintLabel} missing entry_price_usd; stop not armed!`,
                  },
                  sendFn
                );
                missingCostAlertByTradeUuid.set(tradeUuid, now);
              }
            }

            let decision = evalResult?.decision || "hold";
            let decisionReason = null;

            // Hard stop override
            const stopLossEligible =
              hsAbs != null && Number.isFinite(Number(roiPctNow))
                ? Number(roiPctNow) <= -hsAbs
                : false;
            const stopLossDebounceOk =
              now - (state.lastActionTsMs || 0) >= actionDebounceMs;

            if (stopLossEligible && stopLossDebounceOk) {
              state.lastActionTsMs = now;
              decision = "exit";
              decisionReason = "stop_loss";
              emitToParent(
                "sellOps:stopLoss:trigger",
                {
                  ts: now,
                  walletAlias: wallet.alias,
                  tradeUuid,
                  mint,
                  priceUsd: priceUsdNow,
                  costUsd,
                  roiPct: roiPctNow,
                  hardStopLossPct: hsAbs,
                  action: "exit",
                  reason: "stop_loss",
                },
                sendFn
              );
            }

            // Trailing stop state update + override
            if (!decisionReason && Number.isFinite(Number(roiPctNow))) {
              if (
                !state.active &&
                Number(roiPctNow) >= Number(state.activationPct)
              ) {
                state.active = true;
                state.highWaterUsd = priceUsdNow;
                state.stopUsd = state.highWaterUsd * (1 - state.trailPct / 100);
                state.breachCount = 0;
                emitToParent(
                  "sellOps:trailingStop:armed",
                  {
                    ts: now,
                    walletAlias: wallet.alias,
                    tradeUuid,
                    mint,
                    priceUsd: priceUsdNow,
                    costUsd,
                    roiPct: roiPctNow,
                    activationPct: state.activationPct,
                    trailPct: state.trailPct,
                    highWaterUsd: state.highWaterUsd,
                    stopUsd: state.stopUsd,
                  },
                  sendFn
                );
              }

              if (state.active) {
                if (priceUsdNow > state.highWaterUsd) {
                  state.highWaterUsd = priceUsdNow;
                  state.stopUsd =
                    state.highWaterUsd * (1 - state.trailPct / 100);
                  state.breachCount = 0;
                  emitToParent(
                    "sellOps:trailingStop:high",
                    {
                      ts: now,
                      walletAlias: wallet.alias,
                      tradeUuid,
                      mint,
                      priceUsd: priceUsdNow,
                      highWaterUsd: state.highWaterUsd,
                      stopUsd: state.stopUsd,
                    },
                    sendFn
                  );
                }

                if (state.stopUsd > 0 && priceUsdNow <= state.stopUsd) {
                  state.breachCount += 1;
                } else {
                  state.breachCount = 0;
                }

                const eligible = state.breachCount >= breachConfirmations;
                const debounceOk =
                  now - (state.lastActionTsMs || 0) >= actionDebounceMs;
                if (eligible && debounceOk) {
                  state.lastActionTsMs = now;
                  decision = "exit";
                  decisionReason = "trailing_stop";
                  emitToParent(
                    "sellOps:trailingStop:trigger",
                    {
                      ts: now,
                      walletAlias: wallet.alias,
                      tradeUuid,
                      mint,
                      priceUsd: priceUsdNow,
                      costUsd,
                      roiPct: roiPctNow,
                      highWaterUsd: state.highWaterUsd,
                      stopUsd: state.stopUsd,
                      breachCount: state.breachCount,
                      breachConfirmations,
                      action: "exit",
                      reason: "trailing_stop",
                    },
                    sendFn
                  );
                }
              }
            }

            // Execute decision (fast loop handles protective exits; strategy exits come from evalResult.decision)
            const observeOnly = enginePayload.observeOnly === true;
            if (!observeOnly && decision === "exit") {
              try {
                const amtNum = Number(summary.currentTokenAmount);
                const amountDecimal =
                  Number.isFinite(amtNum) && amtNum > 0 ? String(amtNum) : null;
                if (!amountDecimal) {
                  sellOpsLogger.warn(
                    `[sellOps] fast-exit swap payload missing amountDecimal; falling back to percent-only wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint}`
                  );
                }
                await runSwapWithMonitor(
                  {
                    walletAlias: wallet.alias,
                    mint,
                    tradeUuid,
                    side: "sell",
                    ...(amountDecimal
                      ? {
                          amountDecimal,
                          amount: amountDecimal,
                          fromAmountDecimal: amountDecimal,
                        }
                      : {}),
                    percent: 1,
                    sellPercent: 100,
                    sellPct: 100,
                    sellAll: true,
                    isSellAll: true,
                    reason: decisionReason || "strategy_exit",
                    source: "sellOpsWorker",
                    ...(decisionReason === "stop_loss"
                      ? { hardStopLossPct: hsAbs }
                      : {}),
                  },
                  workerEnv
                );
              } catch (err) {
                sellOpsLogger.warn(
                  `[sellOps] fast-exit execution failed wallet=${
                    wallet.alias
                  } trade_uuid=${tradeUuid} mint=${mint}: ${
                    err?.message || err
                  }`
                );
              }
            }

            // Build and persist snapshot for HUD/autopsy
            const regime = computeMarketRegime(evaluation);
            const stopLossDistancePct =
              hsAbs != null && Number.isFinite(Number(roiPctNow))
                ? Number(roiPctNow) + hsAbs
                : null;

            const snapshot = {
              ts: now,
              walletAlias: wallet.alias,
              tradeUuid: tradeUuid,
              mint,
              decision,
              reasons: evalResult?.reasons || [],
              regime,
              evaluation,
            };

            snapshot.riskControls = {
              hardStopLossPct: hsAbs != null ? hsAbs : null,
              stopLossEligible,
              stopLossDistancePct,
              trailing: {
                active: !!state.active,
                activationPct: state.activationPct,
                trailPct: state.trailPct,
                stopUsd: state.stopUsd,
                highWaterUsd: state.highWaterUsd,
                breachCount: state.breachCount,
                lastActionTsMs: state.lastActionTsMs,
                priceUsd: priceUsdNow,
              },
            };

            snapshot.friendly = buildFriendlyEvaluationSummary(snapshot);
            const hudPayload = buildHudPayload(snapshot);
            emitToParent("sellOps:evaluation", hudPayload, sendFn);

            persistSellOpsEvaluation({
              bootyBox: BootyBox,
              summary,
              snapshot,
              hudPayload,
              logger: log,
              walletAlias: wallet.alias,
            });
          }
        } catch (err) {
          sellOpsLogger.warn(
            `[sellOps] fast decision tick failed wallet=${wallet.alias}: ${
              err?.message || err
            }`
          );
        } finally {
          if (!stopped) {
            fastTimer = setTimeout(fastTick, pollMs);
          }
        }
      }

      fastTimer = setTimeout(fastTick, pollMs);
      sellOpsLogger.info(
        `[sellOps] fast decision loop started wallet=${wallet.alias} pollMs=${pollMs}`
      );
    }

    async function tick() {
      if (stopped) return;

      const tickStartedAt = Date.now();
      try {
        if (!client) {
          const resolvedDataEndpoint =
            (payload?.dataEndpoint && String(payload.dataEndpoint).trim()) ||
            (workerEnv.SOLANATRACKER_URL &&
              String(workerEnv.SOLANATRACKER_URL).trim()) ||
            (workerEnv.SOLANATRACKER_DATA_ENDPOINT &&
              String(workerEnv.SOLANATRACKER_DATA_ENDPOINT).trim()) ||
            (workerEnv.WARCHEST_DATA_ENDPOINT &&
              String(workerEnv.WARCHEST_DATA_ENDPOINT).trim()) ||
            undefined;

          sellOpsLogger.debug(
            `[sellOps] calling setup() walletSpecs[0]=${JSON.stringify({
              alias: wallet.alias,
              pubkey: wallet.pubkey
                ? String(wallet.pubkey).slice(0, 6) + "…"
                : null,
              color: wallet.color || null,
            })} dataEndpoint=${
              payload?.dataEndpoint ||
              workerEnv.SOLANATRACKER_URL ||
              workerEnv.SOLANATRACKER_DATA_ENDPOINT ||
              workerEnv.WARCHEST_DATA_ENDPOINT
                ? "set"
                : "missing"
            }`
          );

          client = await setup({
            walletSpecs: [wallet],
            mode: "daemon",
            statusDir: payload.statusDir,
            ...(resolvedDataEndpoint
              ? { dataEndpoint: resolvedDataEndpoint }
              : {}),
          });
          sellOpsLogger.debug(
            `[sellOps] setup() returned client keys=${
              Object.keys(client || {}).join(",") || "none"
            }`
          );
        }
        const ctx =
          BootyBox.modules && BootyBox.modules.context
            ? BootyBox.modules.context
            : null;

        if (!db) {
          db = tools.db || (ctx && ctx.db) || null;
        }

        if (!db && ctx && typeof ctx.getDb === "function") {
          try {
            db = ctx.getDb();
          } catch (err) {
            sellOpsLogger.warn(
              `[sellOps] ctx.getDb() failed: ${err?.message || err}`
            );
          }
        }

        sellOpsLogger.debug(
          `db resolved source=${
            tools.db ? "tools.db" : db ? "bootyboxContext" : "none"
          } ` +
            `keys=${
              Object.keys(db || {})
                .slice(0, 15)
                .join(",") || "none"
            } ` +
            `hasAll=${db && typeof db.all === "function"} hasPrepare=${
              db && typeof db.prepare === "function"
            }`
        );

        if (!dataClient) {
          dataClient =
            tools.dataClient || createSolanaTrackerDataClient({ logger: log });
          log.debug("[sellOps] dataClient created (defaults from env)");
        }

        const { rows } = await BootyBox.loadOpenPositions(wallet.alias);
        const summaries = rows.map(toPositionSummary);

        if (!entryPriceBackfillDone && summaries.length) {
          const result = await backfillEntryPriceUsd({
            db,
            dataClient,
            positions: summaries,
            walletAlias: wallet.alias,
            log: sellOpsLogger,
          });

          entryPriceBackfillDone = true;

          if (result && result.attempted > 0) {
            sellOpsLogger.info(
              `[sellOps] entry_price_usd backfill wallet=${wallet.alias} missing=${result.attempted} ` +
                `updated=${result.updated} pnl=${result.fromPnl} trades=${result.fromTrades} api=${result.fromApi}`
            );
            if (result.updated < result.attempted) {
              sellOpsLogger.warn(
                `[sellOps] entry_price_usd backfill incomplete wallet=${wallet.alias} ` +
                  `remaining=${result.attempted - result.updated}`
              );
            }
          }
        }

        const currentPositions = new Map();
        for (const summary of summaries) {
          if (!summary.tradeUuid) continue;
          currentPositions.set(summary.tradeUuid, summary);
        }

        const closedPositions = [];
        for (const [tradeUuid, summary] of previousOpenPositions.entries()) {
          if (
            !currentPositions.has(tradeUuid) &&
            !autopsiedTradeUuids.has(tradeUuid)
          ) {
            closedPositions.push(summary);
          }
        }

        for (const tradeUuid of decisionActionByTradeUuid.keys()) {
          if (!currentPositions.has(tradeUuid)) {
            decisionActionByTradeUuid.delete(tradeUuid);
            missingCostAlertByTradeUuid.delete(tradeUuid);
            symbolByTradeUuid.delete(tradeUuid);
          }
        }

        previousOpenPositions = currentPositions;

        ensureFastDecisionLoopStarted();

        if (!rows.length) {
          sellOpsLogger.info(
            `[sellOps] wallet=${
              wallet.alias
            } no open positions; rechecking in ${Math.round(
              pollIntervalMs / 1000
            )}s`
          );
          const hb = {
            ts: Date.now(),
            walletAlias: wallet.alias,
            status: "idle",
            message: "No open positions",
            statusLabel: "SellOps: idle",
            openPositions: 0,
            strategyLabel: summarizeStrategyLabel(summaries),
            nextTickMs: pollIntervalMs,
          };
          sellOpsLogger.debug(
            `[sellOps] heartbeat wallet=${wallet.alias} status=${hb.status} open=${hb.openPositions} nextTickMs=${hb.nextTickMs}`
          );
          emitToParent("sellOps:heartbeat", hb, sendFn);
        } else {
          sellOpsLogger.info(
            `[sellOps] wallet=${wallet.alias} evaluating ${rows.length} open position(s)`
          );

          for (const summary of summaries) {
            // Execute by default, but allow explicit observeOnly or env override (tests often run observe-only).
            // Slow tick is HUD/persistence only. Execution happens in the fast decision loop.
            const enginePayload = {
              ...(payload || {}),
              observeOnly: true,
            };

            const evalResult = await evaluatePosition({
              position: summary,
              db,
              dataClient,
              eventIntervals:
                enginePayload.eventIntervals ||
                payload.eventIntervals ||
                DEFAULT_EVENT_INTERVALS,
              payload: enginePayload,
              strategyDocs: STRATEGY_DOCS,
              buildEvaluation,
            });

            const inferredStrategyName = evalResult?.evaluation?.strategy?.name
              ? String(evalResult.evaluation.strategy.name).trim()
              : null;
            const strategySource =
              evalResult?.evaluation?.strategy?.source || null;
            if (
              !summary.strategyName &&
              inferredStrategyName &&
              strategySource === "inferred"
            ) {
              try {
                const result = BootyBox.updatePositionStrategyName({
                  positionId: summary.positionId,
                  strategyName: inferredStrategyName,
                });
                if (result && result.updated) {
                  summary.strategyName = inferredStrategyName;
                }
              } catch (err) {
                log.warn(
                  `[sellOps] strategy update failed position_id=${
                    summary.positionId || "n/a"
                  } trade_uuid=${summary.tradeUuid || "n/a"}: ${
                    err?.message || err
                  }`
                );
              }
            }
            // Symbol caching for alerts
            if (summary.tradeUuid) {
              const sym =
                evalResult?.evaluation?.symbol ||
                evalResult?.evaluation?.coin?.symbol ||
                evalResult?.evaluation?.token?.symbol ||
                summary.symbol ||
                null;
              if (sym) {
                symbolByTradeUuid.set(summary.tradeUuid, String(sym));
              }
            }

            const regime = computeMarketRegime(evalResult.evaluation);

            const snapshot = {
              ts: Date.now(),
              walletAlias: wallet.alias,
              tradeUuid: summary.tradeUuid || null,
              mint: summary.mint,
              decision: evalResult.decision,
              reasons: evalResult.reasons,
              regime,
              evaluation: evalResult.evaluation,
            };

            const docsForDefaults = STRATEGY_DOCS?.flash || null;
            const defaults = getTrailingStopConfig(docsForDefaults);

            const hardStopLossPct = Number.isFinite(
              Number(payload?.hardStopLossPct)
            )
              ? Number(payload.hardStopLossPct)
              : defaults && Number.isFinite(Number(defaults.hardStopLossPct))
              ? Number(defaults.hardStopLossPct)
              : null;

            const roiPctNow = snapshot.evaluation?.derived?.roiUnrealizedPct;
            const hsAbs =
              hardStopLossPct != null
                ? Math.abs(Number(hardStopLossPct))
                : null;

            const stopLossEligible =
              hsAbs != null && Number.isFinite(Number(roiPctNow))
                ? Number(roiPctNow) <= -hsAbs
                : false;

            const stopLossDistancePct =
              hsAbs != null && Number.isFinite(Number(roiPctNow))
                ? Number(roiPctNow) + hsAbs
                : null;

            const priceUsdNow =
              snapshot.evaluation?.coin?.priceUsd ??
              snapshot.evaluation?.coin?.price_usd ??
              null;

            snapshot.riskControls = {
              hardStopLossPct: hsAbs != null ? hsAbs : null,
              stopLossEligible,
              stopLossDistancePct,
              trailing: { active: false, priceUsd: priceUsdNow },
            };

            snapshot.friendly = buildFriendlyEvaluationSummary(snapshot);
            const hudPayload = buildHudPayload(snapshot);
            emitToParent("sellOps:evaluation", hudPayload, sendFn);

            persistSellOpsEvaluation({
              bootyBox: BootyBox,
              summary,
              snapshot,
              hudPayload,
              logger: log,
              walletAlias: wallet.alias,
            });

            const tradeTag = summary.tradeUuid
              ? `trade_uuid=${summary.tradeUuid}`
              : "trade_uuid=?";
            const mintTag = summary.mint ? `mint=${summary.mint}` : "mint=?";

            const symbolTag = snapshot.evaluation?.symbol
              ? `symbol=${snapshot.evaluation.symbol}`
              : "symbol=n/a";
            // const tokenTag = `token=${snapshot.evaluation?.symbol || (summary.mint ? summary.mint.slice(0, 4) : 'mint')}`;

            sellOpsLogger.info(
              `[sellOps] eval wallet=${wallet.alias} ${tradeTag} ${symbolTag} ${mintTag} ` +
                `${snapshot.friendly?.headline || ""} | ${
                  snapshot.friendly?.details || ""
                }`
            );
          }
        }

        if (closedPositions.length) {
          for (const summary of closedPositions) {
            const tradeUuid = summary.tradeUuid;
            if (!tradeUuid || autopsiedTradeUuids.has(tradeUuid)) continue;
            try {
              const result = await runAutopsyForClosedPosition({
                position: summary,
                wallet,
                workerEnv,
                runAutopsy: tools.runAutopsy,
              });
              autopsiedTradeUuids.add(tradeUuid);
              const ai = result?.ai || null;
              emitToParent(
                "sellOps:autopsy",
                {
                  ts: Date.now(),
                  walletAlias: wallet.alias,
                  tradeUuid,
                  mint: summary.mint,
                  grade: ai?.grade || null,
                  summary: ai?.summary || null,
                  tags: Array.isArray(ai?.tags) ? ai.tags : [],
                  ai: ai || null,
                  artifactPath: result?.artifactPath || null,
                },
                sendFn
              );
            } catch (err) {
              const msg = err?.message || err;
              log.warn(
                `[sellOps] autopsy failed trade_uuid=${tradeUuid} mint=${
                  summary.mint || "n/a"
                }: ${msg}`
              );
            }
          }
        }
      } catch (err) {
        log.error(
          `[sellOps] tick failed for wallet=${wallet.alias}: ${
            err?.message || err
          }`
        );
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const nextDelayMs = Math.max(0, pollIntervalMs - elapsedMs);
      pollTimer = setTimeout(tick, nextDelayMs);
      track({
        close: () => {
          if (pollTimer) clearTimeout(pollTimer);
        },
      });
    }

    async function bootstrap() {
      log.info(
        `[sellOps] started wallet=${wallet.alias} pollIntervalMs=${pollIntervalMs}`
      );
      await tick();
    }

    bootstrap().catch(reject);
    stopFn = finish;
  });

  return {
    start() {
      return finalPromise;
    },
    stop(reason) {
      if (stopFn) stopFn(reason);
      return finalPromise;
    },
  };
}

module.exports = {
  createSellOpsController,
};
