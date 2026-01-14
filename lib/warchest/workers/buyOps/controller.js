"use strict";

const path = require("path");

const BootyBox = require("../../../../db");
const { ensureBootyBoxInit } = require("../../../bootyBoxInit");
const { emitToParent } = require("../sellOps/hudPublisher");
const { toPositionSummary } = require("../sellOps/positionAdapter");
const { getHubCoordinator } = require("../../hub");
const {
  createSolanaTrackerRPCClient,
} = require("../../../solanaTrackerRPCClient");
const { createRpcMethods } = require("../../../solana/rpcMethods");
const { forkWorkerWithPayload } = require("../harness");
const {
  createNoopLogger,
  normalizeMint,
  normalizeScopedLogger,
  parseIntervalMs,
  parseNumber,
  parseRatio,
} = require("../opsUtils");
const {
  getStrategyDocs,
  resolveStrategyLabel,
  resolveStrategyOverride,
} = require("../strategyRegistry");
const { persistBuyOpsEvaluation } = require("./persistence");

const DEFAULT_EVAL_INTERVAL_MS = 60_000;
const DEFAULT_EVAL_CONCURRENCY = 6;
const DEFAULT_MIN_BUY_SCORE = 65;
const DEFAULT_EVAL_TIMEOUT_MS = 20_000;
const DEFAULT_BALANCE_CAP_PCT = 1;
const DEFAULT_TREND_UP_TICKS = 3;
const RESERVE_SOL_PER_POSITION = 0.03;

const EVAL_STATUSES = ["strong_buy", "buy", "watch"];
const EVAL_WORKER_PATH = path.join(__dirname, "evalWorker.js");

const STRATEGY_DOCS = getStrategyDocs();

const hub = getHubCoordinator({ attachSignals: false });

async function runSwapWithMonitor(payload, workerEnv, logger) {
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
      logger.warn(
        `[buyOps] tx monitor failed to start: ${err?.message || err}`
      );
    }
  }
  return result || null;
}

function resolveBuyAmount(evalResult) {
  const amount = Number(evalResult?.evaluation?.position?.expectedNotionalSol);
  if (Number.isFinite(amount) && amount > 0) return amount;
  return null;
}

// Helper: pick failed gate IDs from evaluation
function pickFailedGateIds(evaluation, limit = 2) {
  const results = evaluation?.qualify?.results;
  if (!Array.isArray(results) || !results.length) return [];
  const failed = results.filter((r) => r && r.pass === false);
  if (!failed.length) return [];
  return failed.slice(0, limit).map((r) => r.id || "gate?");
}

// Helper: build compact HUD payload for BUY decision
function buildBuyHudPayload({
  wallet,
  mint,
  target,
  evalResult,
  minScore,
  regimeConfirm,
}) {
  const evaluation = evalResult?.evaluation || {};
  const regimeStatus = evalResult?.regime?.status || null;
  const regimeSignals = evalResult?.regime?.signals || null;
  const expectedNotionalSol = evaluation?.position?.expectedNotionalSol ?? null;
  const warningsCount = Array.isArray(evaluation?.warnings)
    ? evaluation.warnings.length
    : 0;
  const risk = evaluation?.risk || {};
  const pool = evaluation?.pool || {};

  const qualifyWorst = evaluation?.qualify?.worstSeverity || "none";
  const failedGateIds = pickFailedGateIds(evaluation, 2);

  const score = target?.score ?? null;
  const confidence = target?.confidence ?? null;
  const symbol =
    target?.symbol || evaluation?.coin?.symbol || evaluation?.symbol || null;

  const statusLine =
    `BUY? ${symbol || mint.slice(0, 4)} score=${
      Number.isFinite(score) ? score : "n/a"
    } ` +
    `conf=${Number.isFinite(confidence) ? confidence.toFixed(2) : "n/a"} ` +
    `regime=${regimeStatus || "n/a"}${
      regimeSignals && regimeSignals.emaTrend
        ? `(${regimeSignals.emaTrend})`
        : ""
    }` +
    (regimeConfirm
      ? ` tUp=${regimeConfirm.current}/${regimeConfirm.required}`
      : "") +
    ` notional=${
      expectedNotionalSol != null ? expectedNotionalSol : "n/a"
    }SOL ` +
    `risk=${String(qualifyWorst).toUpperCase()}` +
    (failedGateIds.length ? ` fails=${failedGateIds.join(",")}` : "") +
    (warningsCount ? ` warnings=${warningsCount}` : "");

  return {
    ts: Date.now(),
    walletAlias: wallet?.alias || null,
    walletId: wallet?.walletId || null,
    mint,
    symbol,
    decision: "buy",
    statusLine,
    state: {
      score,
      confidence,
      minScore,
      regimeStatus,
      regimeSignals,
      regimeConfirm: regimeConfirm || null,
      strategy: evaluation?.strategy || null,
      expectedNotionalSol,
      warningsCount,
      qualifyWorstSeverity: qualifyWorst,
      failedGateIds,
      // a few entry-relevant facts
      liquidityUsd: pool?.liquidity_usd ?? null,
      rugged: risk?.rugged ?? null,
      riskScore: risk?.riskScore ?? null,
      top10Percent: risk?.top10Percent ?? null,
      snipersTotalPercent: risk?.snipersTotalPercent ?? null,
      devPercent: risk?.devPercent ?? null,
    },
    reasons: Array.isArray(evalResult?.reasons) ? evalResult.reasons : [],
  };
}

// Best-effort updater for opened position's strategy (post-buy)
async function updateOpenedPositionStrategyBestEffort({
  walletAlias,
  mint,
  strategyName,
  logger,
}) {
  const log = logger;
  if (!strategyName) return;
  if (
    typeof BootyBox.updatePositionStrategyName !== "function" ||
    typeof BootyBox.loadOpenPositions !== "function"
  ) {
    return;
  }
  const delays = [250, 500, 1000, 1500, 2000, 3000];
  for (let i = 0; i < delays.length; ++i) {
    try {
      const openPositions = await BootyBox.loadOpenPositions(walletAlias);
      const rows = Array.isArray(openPositions?.rows) ? openPositions.rows : [];
      const normMint = normalizeMint(mint);
      const row = rows.find((r) => normalizeMint(r.coin_mint) === normMint);
      if (row) {
        const summary = toPositionSummary(row);
        if (summary?.positionId) {
          try {
            await BootyBox.updatePositionStrategyName({
              positionId: summary.positionId,
              strategyName,
            });
            log &&
              typeof log.info === "function" &&
              log.info(
                `[buyOps] updated opened position strategy mint=${mint} positionId=${summary.positionId} strategy=${strategyName}`
              );
          } catch (err) {
            log &&
              typeof log.warn === "function" &&
              log.warn(
                `[buyOps] failed to update opened position strategy mint=${mint} positionId=${
                  summary.positionId
                } strategy=${strategyName}: ${err?.message || err}`
              );
          }
          return;
        } else {
          log &&
            typeof log.warn === "function" &&
            log.warn(
              `[buyOps] could not update opened position strategy (row found but no positionId) mint=${mint} strategy=${strategyName}`
            );
          return;
        }
      }
    } catch (err) {
      log &&
        typeof log.warn === "function" &&
        log.warn(
          `[buyOps] error while updating opened position strategy mint=${mint} strategy=${strategyName}: ${
            err?.message || err
          }`
        );
    }
    // delay before next try
    await new Promise((resolve) => setTimeout(resolve, delays[i]));
  }
  log &&
    typeof log.warn === "function" &&
    log.warn(
      `[buyOps] could not update opened position strategy (position not found) mint=${mint} strategy=${strategyName}`
    );
}
/**
 * @typedef {Object} BuyOpsController
 * @property {Function} start
 * @property {Function} stop
 */

/**
 * Create a BuyOps controller that schedules the evaluation loop.
 *
 * @param {Object} payload
 * @param {Object} tools
 * @param {Object} log
 * @returns {BuyOpsController}
 */
function createBuyOpsController(payload = {}, tools = {}, log) {
  // Use buyOpsWorker's scoped logger when provided; do not create a new logger or write to stdout.
  const baseLogger = log || tools.logger || createNoopLogger();
  const logger = normalizeScopedLogger(baseLogger, "buyOps");
  const env = tools.env || process.env;

  const evaluationIntervalMs = parseIntervalMs(
    payload.evaluationIntervalMs ??
      payload.evalIntervalMs ??
      payload.targetScanIntervalMs ??
      env.WARCHEST_BUYOPS_EVAL_INTERVAL_MS,
    DEFAULT_EVAL_INTERVAL_MS
  );
  const evaluationConcurrency = Math.max(
    1,
    parseNumber(
      payload.evaluationConcurrency ??
        payload.evalConcurrency ??
        env.WARCHEST_BUYOPS_EVAL_CONCURRENCY,
      DEFAULT_EVAL_CONCURRENCY
    )
  );
  const minScore = parseNumber(payload.minScore, DEFAULT_MIN_BUY_SCORE);
  const evalTimeoutMs = parseNumber(
    payload.evalTimeoutMs ?? env.WARCHEST_BUYOPS_EVAL_TIMEOUT_MS,
    DEFAULT_EVAL_TIMEOUT_MS
  );
  const balanceCapPct = parseRatio(
    payload.balancePct ?? env.WARCHEST_BUYOPS_BALANCE_PCT,
    DEFAULT_BALANCE_CAP_PCT
  );

  let evaluationTimer = null;
  let heartbeatTimer = null;
  let runningEvaluation = false;
  let runningEvaluationStartedAt = null;
  let stopped = false;
  let lastEvaluationStartedAt = null;
  let lastEvaluationCompletedAt = null;
  let stopFn = null;
  let buyInFlight = false;
  // Controller-scoped state for last known wallet/strategy and evaluation stats
  let lastWalletAlias = null;
  let lastStrategyLabel = null;
  let lastTargets = 0;
  let lastEvaluated = 0;
  let lastDecisions = { buy: 0, watch: 0, skip: 0 };
  let lastErrors = 0;
  // Regime confirmation: require trend_up for N consecutive evaluation ticks before buying
  const trendUpStreakByMint = new Map(); // mint -> { count, lastTs }
  const requiredTrendUpTicks = Math.max(
    1,
    parseNumber(payload.regimeConfirmTicks, DEFAULT_TREND_UP_TICKS)
  );
  const TREND_UP_STREAK_RESET_MS = 120_000;
  let rpcClient = null;
  let rpcMethods = null;

  async function ensureBootyBox() {
    try {
      await ensureBootyBoxInit();
      return true;
    } catch (err) {
      logger.warn(`[buyOps] BootyBox init failed: ${err?.message || err}`);
      return false;
    }
  }

  function loadDefaultFundingWallet() {
    if (typeof BootyBox.getDefaultFundingWallet !== "function") return null;
    return BootyBox.getDefaultFundingWallet();
  }

  async function ensureRpcMethods() {
    if (rpcMethods) return rpcMethods;
    try {
      rpcClient = createSolanaTrackerRPCClient();
      rpcMethods = createRpcMethods(rpcClient.rpc, rpcClient.rpcSubs);
      return rpcMethods;
    } catch (err) {
      logger.warn(`[buyOps] RPC init failed: ${err?.message || err}`);
      return null;
    }
  }

  async function fetchWalletSolBalance(wallet) {
    if (!wallet?.pubkey) {
      logger.warn("[buyOps] wallet pubkey missing; cannot fetch SOL balance");
      return null;
    }
    const methods = await ensureRpcMethods();
    if (!methods || typeof methods.getSolBalance !== "function") {
      logger.warn(
        "[buyOps] RPC getSolBalance unavailable; cannot fetch SOL balance"
      );
      return null;
    }

    try {
      const balance = await methods.getSolBalance(wallet.pubkey);
      const num = Number(balance);
      return Number.isFinite(num) ? num : null;
    } catch (err) {
      logger.warn(`[buyOps] SOL balance fetch failed: ${err?.message || err}`);
      return null;
    }
  }

  function buildTargetStrategyUpdate(target, strategyDoc) {
    if (!target || !strategyDoc) return null;
    const now = Date.now();
    return {
      mint: target.mint,
      symbol: target.symbol || null,
      name: target.name || null,
      status: target.status || "new",
      strategy: strategyDoc.name || null,
      strategyId: strategyDoc.strategyId || null,
      source: target.source || "buyOps",
      tags: target.tags || null,
      notes: target.notes || null,
      vectorStoreId: target.vector_store_id || null,
      vectorStoreFileId: target.vector_store_file_id || null,
      vectorStoreUpdatedAt: Number.isFinite(target.vector_store_updated_at)
        ? target.vector_store_updated_at
        : null,
      confidence: Number.isFinite(target.confidence) ? target.confidence : null,
      score: Number.isFinite(target.score) ? target.score : null,
      mintVerified: target.mint_verified === 1,
      createdAt: Number.isFinite(target.created_at) ? target.created_at : now,
      updatedAt: now,
      lastCheckedAt: now,
    };
  }

  function updateTrendUpStreak(mint, regimeStatus) {
    const nowMs = Date.now();
    const prev = trendUpStreakByMint.get(mint) || { count: 0, lastTs: 0 };
    const stale = prev.lastTs && nowMs - prev.lastTs > TREND_UP_STREAK_RESET_MS;
    const base = stale ? { count: 0, lastTs: 0 } : prev;

    const next = { count: base.count, lastTs: nowMs };

    if (regimeStatus === "trend_up") {
      next.count = base.lastTs ? base.count + 1 : 1;
    } else {
      next.count = 0;
    }

    trendUpStreakByMint.set(mint, next);
    return next.count;
  }

  async function runEvaluationTick() {
    if (runningEvaluation || stopped) {
      if (runningEvaluation && runningEvaluationStartedAt) {
        const ageMs = Date.now() - runningEvaluationStartedAt;
        if (Number.isFinite(ageMs) && ageMs > evalTimeoutMs) {
          logger.warn(
            `[buyOps] evaluation still running after ${Math.round(
              ageMs / 1000
            )}s; skipping new tick.`
          );
        }
      }
      return null;
    }
    runningEvaluation = true;
    runningEvaluationStartedAt = Date.now();
    lastEvaluationStartedAt = runningEvaluationStartedAt;
    try {
      const decisions = { buy: 0, watch: 0, skip: 0 };
      let evaluated = 0;
      let errors = 0;
      const hasBootyBox = await ensureBootyBox();
      const wallet = loadDefaultFundingWallet();
      if (!hasBootyBox) {
        // update cached stats
        lastTargets = 0;
        lastEvaluated = evaluated;
        lastDecisions = decisions;
        lastErrors = errors;
        emitToParent("buyOps:heartbeat", {
          ts: Date.now(),
          walletAlias: null,
          status: "skipped",
          note: "bootybox unavailable",
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      if (!wallet) {
        logger.warn(
          "[buyOps] default funding wallet missing; skipping evaluation."
        );
        // update cached stats
        lastTargets = 0;
        lastEvaluated = evaluated;
        lastDecisions = decisions;
        lastErrors = errors;
        emitToParent("buyOps:heartbeat", {
          ts: Date.now(),
          walletAlias: null,
          status: "skipped",
          note: "default funding wallet missing",
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      const walletStrategyRaw =
        wallet.strategy || wallet.strategyId || wallet.strategy_id || null;
      const walletStrategyDoc = resolveStrategyOverride(walletStrategyRaw);
      const strategyLabel = resolveStrategyLabel(
        walletStrategyRaw,
        walletStrategyDoc
      );
      // cache wallet alias and strategy label
      lastWalletAlias = wallet.alias;
      lastStrategyLabel = strategyLabel;
      // -- HYBRID strategy: ensure candles/ohlcv by default unless overridden
      const isHybridWallet = Boolean(
        walletStrategyDoc &&
          String(walletStrategyDoc.name || "").toUpperCase() === "HYBRID"
      );
      const wantCandles =
        payload.includeCandles != null
          ? Boolean(payload.includeCandles)
          : isHybridWallet;
      const wantOhlcv =
        payload.includeOhlcv != null
          ? payload.includeOhlcv !== false
          : wantCandles || isHybridWallet;
      if (walletStrategyRaw && !walletStrategyDoc) {
        logger.warn(
          `[buyOps] wallet strategy "${walletStrategyRaw}" did not match known strategies; falling back to inference.`
        );
      }

      if (typeof BootyBox.listTargetsByPriority !== "function") {
        logger.warn(
          "[buyOps] listTargetsByPriority unavailable; skipping evaluation."
        );
        // update cached stats
        lastTargets = 0;
        lastEvaluated = evaluated;
        lastDecisions = decisions;
        lastErrors = errors;
        emitToParent("buyOps:heartbeat", {
          ts: Date.now(),
          walletAlias: wallet.alias,
          status: "skipped",
          strategyLabel,
          note: "listTargetsByPriority unavailable",
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      const targets = BootyBox.listTargetsByPriority({
        statuses: EVAL_STATUSES,
        minScore,
      });
      if (!targets.length) {
        // update cached stats
        lastTargets = 0;
        lastEvaluated = evaluated;
        lastDecisions = decisions;
        lastErrors = errors;
        emitToParent("buyOps:heartbeat", {
          ts: Date.now(),
          walletAlias: wallet.alias,
          status: "idle",
          strategyLabel,
          targets: 0,
          evaluated,
          decisions,
          errors,
          note: "no targets to evaluate",
        });
        return {
          targets: 0,
          evaluated,
          decisions,
          errors,
        };
      }

      const openPositions =
        typeof BootyBox.loadOpenPositions === "function"
          ? BootyBox.loadOpenPositions(wallet.alias)
          : { rows: [] };
      const openRows = Array.isArray(openPositions?.rows)
        ? openPositions.rows
        : [];
      const openByMint = new Map(
        openRows.map((row) => [normalizeMint(row.coin_mint), row])
      );
      const openPositionCount = openRows.length;
      let balanceSnapshotPromise = null;

      // ---- portfolio cap (early live testing) ----
      const maxOpenPositions = Number.isFinite(
        Number(payload?.maxOpenPositions)
      )
        ? Number(payload.maxOpenPositions)
        : Number.isFinite(
            Number(walletStrategyDoc?.portfolio?.limits?.maxOpenPositions)
          )
        ? Number(walletStrategyDoc.portfolio.limits.maxOpenPositions)
        : 5;
      const openPositionsCount = openPositionCount;

      const getBalanceSnapshot = async () => {
        if (balanceSnapshotPromise) return balanceSnapshotPromise;
        balanceSnapshotPromise = (async () => {
          const balanceSol = await fetchWalletSolBalance(wallet);
          if (!Number.isFinite(balanceSol)) {
            return {
              balanceSol: null,
              reservedSol: null,
              availableSol: null,
              capSol: null,
            };
          }
          const reservedSol = openPositionCount * RESERVE_SOL_PER_POSITION;
          const availableSol = balanceSol - reservedSol;
          const capSol = Number.isFinite(balanceCapPct)
            ? availableSol * balanceCapPct
            : availableSol;
          return { balanceSol, reservedSol, availableSol, capSol };
        })();
        return balanceSnapshotPromise;
      };

      const entries = [];
      for (const target of targets) {
        const mint = target?.mint;
        if (!mint) continue;
        const openRow = openByMint.get(normalizeMint(mint)) || null;
        const targetStrategyDoc = resolveStrategyOverride(
          target?.strategy || target?.strategy_id
        );
        const position = openRow
          ? toPositionSummary(openRow)
          : {
              walletId: wallet.walletId,
              walletAlias: wallet.alias,
              mint,
              tradeUuid: null,
              strategyId: targetStrategyDoc?.strategyId || null,
              strategyName: targetStrategyDoc?.name || null,
              currentTokenAmount: null,
              source: "buyOps",
            };

        if (openRow && !position.strategyName && targetStrategyDoc) {
          position.strategyName = targetStrategyDoc.name || null;
          position.strategyId = targetStrategyDoc.strategyId || null;
        }

        entries.push({ target, position, targetStrategyDoc });
      }

      const workerTimeoutMs = Number.isFinite(evalTimeoutMs)
        ? Math.max(10_000, evalTimeoutMs + 5_000)
        : 30_000;
      let cursor = 0;

      const runNext = async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= entries.length) return;
          const entry = entries[idx];
          const mint = entry?.position?.mint || entry?.target?.mint || "mint";
          const evalStartedAt = Date.now();
          logger.info(`[buyOps] evaluating mint=${mint}`);

          try {
            const { result } = await forkWorkerWithPayload(EVAL_WORKER_PATH, {
              payload: {
                position: entry.position,
                target: entry.target,
                walletStrategyRaw,
                minScore,
                eventIntervals: payload.eventIntervals || ["5m", "15m", "1h"],
                ohlcv: wantOhlcv
                  ? {
                      type: payload.ohlcvType || "1m",
                      lookbackMs: payload.ohlcvLookbackMs || 60 * 60 * 1000,
                      fastCache: true,
                      removeOutliers: true,
                    }
                  : null,
                indicators: wantOhlcv
                  ? {
                      vwapPeriods: payload.vwapPeriods ?? 60,
                    }
                  : null,
                includeCandles: wantCandles,
                includeOhlcv: wantOhlcv,
                evalTimeoutMs,
              },
              env,
              timeoutMs: workerTimeoutMs,
            });

            const evalResult = result || null;
            evaluated += 1;
            if (
              evalResult?.decision &&
              Object.prototype.hasOwnProperty.call(
                decisions,
                evalResult.decision
              )
            ) {
              decisions[evalResult.decision] += 1;
            } else {
              decisions.skip += 1;
            }
            const reasonList = Array.isArray(evalResult?.reasons)
              ? evalResult.reasons
              : [];
            const reasonText = ` reasons=${JSON.stringify(reasonList)}`;
            logger.info(
              `[buyOps] evaluated mint=${mint} decision=${
                evalResult?.decision || "n/a"
              } ` + `ms=${Date.now() - evalStartedAt}${reasonText}`
            );

            if (
              !walletStrategyDoc &&
              !entry.targetStrategyDoc &&
              evalResult?.chosenStrategy?.name
            ) {
              const update = buildTargetStrategyUpdate(
                entry.target,
                evalResult.chosenStrategy
              );
              if (update && typeof BootyBox.addUpdateTarget === "function") {
                try {
                  BootyBox.addUpdateTarget(update);
                } catch (err) {
                  logger.warn(
                    `[buyOps] failed to persist target strategy for ${mint}: ${
                      err?.message || err
                    }`
                  );
                }
              }
            }

            if (
              evalResult?.decision === "buy" &&
              evalResult?.evaluation?.strategy?.name &&
              entry.position?.positionId &&
              typeof BootyBox.updatePositionStrategyName === "function"
            ) {
              try {
                BootyBox.updatePositionStrategyName({
                  positionId: entry.position.positionId,
                  strategyName: evalResult.evaluation.strategy.name,
                });
              } catch (err) {
                logger.warn(
                  `[buyOps] failed to update position strategy for ${mint}: ${
                    err?.message || err
                  }`
                );
              }
            }

            if (evalResult?.evaluation) {
              const snapshot = {
                ts: Date.now(),
                walletId: wallet.walletId,
                walletAlias: wallet.alias,
                tradeUuid: entry.position.tradeUuid || null,
                mint,
                decision: evalResult.decision,
                reasons: evalResult.reasons,
                regime: evalResult.regime,
                evaluation: evalResult.evaluation,
              };

              persistBuyOpsEvaluation({
                bootyBox: BootyBox,
                target: entry.target,
                snapshot,
                logger,
              });

              // BUY-only activity/HUD event is emitted later (after we compute the regime confirmation streak once).
            }

            if (evalResult?.decision === "buy") {
              const regimeStatus = evalResult?.regime?.status || null;
              const trendUpTicks = updateTrendUpStreak(mint, regimeStatus);
              // BUY-only activity/HUD event (compact) so we can tune entries without digging logs.
              try {
                const hudPayload = buildBuyHudPayload({
                  wallet,
                  mint,
                  target: entry.target,
                  evalResult,
                  minScore,
                  regimeConfirm: {
                    required: requiredTrendUpTicks,
                    current: trendUpTicks,
                  },
                });
                emitToParent("buyOps:buy", hudPayload);
              } catch (err) {
                logger.warn(
                  `[buyOps] failed to emit buy HUD payload for ${mint}: ${
                    err?.message || err
                  }`
                );
              }
              const hasOpenPosition =
                Boolean(entry.position?.tradeUuid) ||
                (Number.isFinite(Number(entry.position?.currentTokenAmount)) &&
                  Number(entry.position.currentTokenAmount) > 0);

              if (regimeStatus !== "trend_up") {
                logger.info(
                  `[buyOps] buy skipped mint=${mint} reason=regime status=${
                    regimeStatus || "n/a"
                  }`
                );
              } else if (hasOpenPosition) {
                logger.info(
                  `[buyOps] buy skipped mint=${mint} reason=position_open`
                );
              } else if (buyInFlight) {
                logger.info(
                  `[buyOps] buy skipped mint=${mint} reason=swap_in_flight`
                );
              } else if (trendUpTicks < requiredTrendUpTicks) {
                logger.info(
                  `[buyOps] buy skipped mint=${mint} reason=regime_confirm trend_up_ticks=${trendUpTicks}/${requiredTrendUpTicks}`
                );
              } else if (openPositionsCount >= maxOpenPositions) {
                logger.info(
                  `[buyOps] buy skipped mint=${mint} reason=max_open_positions open=${openPositionsCount} max=${maxOpenPositions}`
                );
                // TODO(cooldown): Add loss-aware cooldown per mint (longer after hard-stop/stop-loss,
                // shorter after trailing-stop in trend_up) using latest SellOps exit reason + ROI from DB.
              } else {
                const requestedAmount = resolveBuyAmount(evalResult);
                if (!requestedAmount) {
                  logger.warn(
                    `[buyOps] buy skipped mint=${mint} reason=missing_amount`
                  );
                } else {
                  const balanceSnapshot = await getBalanceSnapshot();
                  if (!Number.isFinite(balanceSnapshot?.balanceSol)) {
                    logger.warn(
                      `[buyOps] buy skipped mint=${mint} reason=balance_unavailable`
                    );
                    continue;
                  }
                  if (!(balanceSnapshot.availableSol > 0)) {
                    logger.warn(
                      `[buyOps] buy skipped mint=${mint} reason=balance_reserved available=${balanceSnapshot.availableSol}`
                    );
                    continue;
                  }

                  let amount = requestedAmount;
                  const capSol = balanceSnapshot.capSol;
                  if (
                    Number.isFinite(capSol) &&
                    capSol > 0 &&
                    amount > capSol
                  ) {
                    amount = capSol;
                  }
                  if (!(amount > 0)) {
                    logger.warn(
                      `[buyOps] buy skipped mint=${mint} reason=balance_cap`
                    );
                    continue;
                  }

                  // Capture intended strategy name for this buy
                  const buyStrategyName =
                    evalResult?.evaluation?.strategy?.name ||
                    walletStrategyDoc?.name ||
                    null;

                  // Before dispatching swap, persist the target's strategy (HYBRID or chosen)
                  let strategyDocToPersist =
                    resolveStrategyOverride(buyStrategyName) ||
                    walletStrategyDoc ||
                    null;
                  const updateObj = buildTargetStrategyUpdate(
                    entry.target,
                    strategyDocToPersist
                  );
                  if (
                    updateObj &&
                    typeof BootyBox.addUpdateTarget === "function"
                  ) {
                    try {
                      BootyBox.addUpdateTarget(updateObj);
                    } catch (err) {
                      logger.warn(
                        `[buyOps] failed to persist target strategy for ${mint}: ${
                          err?.message || err
                        }`
                      );
                    }
                  }

                  buyInFlight = true;
                  const swapPayload = {
                    walletAlias: wallet.alias,
                    walletId: wallet.walletId,
                    mint,
                    side: "buy",
                    amount,
                    reason: "buyOps",
                    source: "buyOpsWorker",
                    strategyName: buyStrategyName,
                    targetStatus: entry.target?.status || null,
                    targetScore: entry.target?.score ?? null,
                    targetConfidence: entry.target?.confidence ?? null,
                    walletSolBalance: balanceSnapshot.balanceSol,
                    balanceReservedSol: balanceSnapshot.reservedSol,
                  };

                  logger.info(
                    `[buyOps] dispatching buy swap mint=${mint} amount=${amount} reason=regime_trend_up`
                  );
                  runSwapWithMonitor(swapPayload, env, logger)
                    .then((swapResult) => {
                      logger.info(
                        `[buyOps] buy swap submitted mint=${mint} txid=${
                          swapResult?.txid || "n/a"
                        }`
                      );
                      // After swap submission, best-effort update opened position's strategy
                      updateOpenedPositionStrategyBestEffort({
                        walletAlias: wallet.alias,
                        mint,
                        strategyName: buyStrategyName,
                        logger,
                      });
                    })
                    .catch((err) => {
                      logger.warn(
                        `[buyOps] buy swap failed mint=${mint}: ${
                          err?.message || err
                        }`
                      );
                    })
                    .finally(() => {
                      // Fallback: best-effort update in case monitor result is absent
                      updateOpenedPositionStrategyBestEffort({
                        walletAlias: wallet.alias,
                        mint,
                        strategyName: buyStrategyName,
                        logger,
                      });
                      buyInFlight = false;
                    });
                }
              }
            }
          } catch (err) {
            errors += 1;
            logger.warn(
              `[buyOps] evaluation failed mint=${mint} ms=${
                Date.now() - evalStartedAt
              }: ${err?.message || err}`
            );
          }

          await new Promise((resolve) => setImmediate(resolve));
        }
      };

      const workerCount = Math.min(evaluationConcurrency, entries.length);
      const workers = Array.from({ length: workerCount }, () => runNext());
      await Promise.all(workers);

      lastEvaluationCompletedAt = Date.now();
      // update cached stats
      lastTargets = entries.length;
      lastEvaluated = evaluated;
      lastDecisions = decisions;
      lastErrors = errors;
      emitToParent("buyOps:heartbeat", {
        ts: Date.now(),
        walletAlias: wallet.alias,
        status: "evaluated",
        strategyLabel,
        targets: entries.length,
        evaluated,
        decisions,
        errors,
        note: runningEvaluation ? "evaluation running" : "evaluation idle",
      });

      return {
        targets: entries.length,
        evaluated,
        decisions,
        errors,
      };
    } finally {
      runningEvaluation = false;
      runningEvaluationStartedAt = null;
    }
  }

  async function stop(reason) {
    if (!stopped) stopped = true;
    if (evaluationTimer) clearInterval(evaluationTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (rpcClient && typeof rpcClient.close === "function") {
      try {
        await rpcClient.close();
      } catch (err) {
        logger.warn(`[buyOps] RPC close failed: ${err?.message || err}`);
      }
    }
    return { status: "stopped", reason: reason || null };
  }

  const finalPromise = new Promise((resolve, reject) => {
    async function finish(reason) {
      if (stopped) return;
      stopped = true;
      try {
        const result = await stop(reason || "stopped");
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    async function bootstrap() {
      await ensureBootyBox();
      // Try to load default wallet and strategy for initial heartbeat
      try {
        const w = loadDefaultFundingWallet();
        if (w && w.alias) {
          lastWalletAlias = w.alias;
          const raw = w.strategy || w.strategyId || w.strategy_id || null;
          const doc = resolveStrategyOverride(raw);
          lastStrategyLabel = resolveStrategyLabel(raw, doc);
        }
      } catch (_) {
        // ignore
      }
      emitToParent("buyOps:heartbeat", {
        ts: Date.now(),
        walletAlias: lastWalletAlias,
        strategyLabel: lastStrategyLabel,
        status: "starting",
        evaluationIntervalMs,
        evaluationConcurrency,
        minScore,
      });

      if (evaluationIntervalMs != null) {
        runEvaluationTick()
          .then((evalStats) => {
            if (!evalStats) return;
            logger.info(
              `[buyOps] evaluation summary targets=${evalStats.targets} evaluated=${evalStats.evaluated} ` +
                `buy=${evalStats.decisions.buy} watch=${evalStats.decisions.watch} skip=${evalStats.decisions.skip} ` +
                `errors=${evalStats.errors}`
            );
          })
          .catch((err) => {
            logger.warn(
              `[buyOps] evaluation tick failed: ${err?.message || err}`
            );
          });
        evaluationTimer = setInterval(() => {
          runEvaluationTick()
            .then((evalStats) => {
              if (!evalStats) return;
              logger.info(
                `[buyOps] evaluation summary targets=${evalStats.targets} evaluated=${evalStats.evaluated} ` +
                  `buy=${evalStats.decisions.buy} watch=${evalStats.decisions.watch} skip=${evalStats.decisions.skip} ` +
                  `errors=${evalStats.errors}`
              );
            })
            .catch((err) => {
              logger.warn(
                `[buyOps] evaluation tick failed: ${err?.message || err}`
              );
            });
        }, evaluationIntervalMs);
      } else {
        logger.info("[buyOps] evaluation interval disabled.");
      }

      heartbeatTimer = setInterval(() => {
        if (stopped) return;
        emitToParent("buyOps:heartbeat", {
          ts: Date.now(),
          walletAlias: lastWalletAlias,
          strategyLabel: lastStrategyLabel,
          status: "alive",
          evaluationIntervalMs,
          evaluationConcurrency,
          lastEvaluationStartedAt,
          lastEvaluationCompletedAt,
          targets: lastTargets,
          evaluated: lastEvaluated,
          decisions: lastDecisions,
          errors: lastErrors,
          note: runningEvaluation ? "evaluation running" : "evaluation idle",
        });
        logger.info(
          `[buyOps] heartbeat alive evaluation=${
            lastEvaluationCompletedAt ? "ok" : "pending"
          }`
        );
      }, 60_000);

      logger.info(
        `[buyOps] started evaluationIntervalMs=${
          evaluationIntervalMs ?? "disabled"
        } ` +
          `evaluationConcurrency=${evaluationConcurrency} minScore=${minScore}`
      );
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
  createBuyOpsController,
};
