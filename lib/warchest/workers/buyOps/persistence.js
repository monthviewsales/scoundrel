"use strict";

const {
  buildHudChart,
  buildHudIndicators,
  buildHudMetrics,
} = require("../sellOps/indicatorAdapter");
const { compactEvaluationForStorage } = require("../sellOps/persistence");

/**
 * Persist a BuyOps evaluation payload (best-effort, non-fatal).
 *
 * @param {Object} args
 * @param {any} args.bootyBox
 * @param {Object} args.target
 * @param {Object} args.snapshot
 * @param {Object} args.logger
 */
function persistBuyOpsEvaluation({ bootyBox, target, snapshot, logger }) {
  if (!bootyBox || typeof bootyBox.insertBuyOpsEvaluation !== "function")
    return;
  if (!snapshot?.walletId || !snapshot?.mint) return;

  const evaluation = snapshot.evaluation || {};
  const qualifyResults = Array.isArray(evaluation?.qualify?.results)
    ? evaluation.qualify.results
    : [];

  const failedGates = qualifyResults.filter((r) => r && r.outcome === "fail");
  const worstSeverity = evaluation?.qualify?.worstSeverity || null;
  const gateFail =
    (worstSeverity &&
      failedGates.find((g) => g.severityOnFail === worstSeverity)?.id) ||
    (failedGates[0] ? failedGates[0].id : null);

  const metrics = buildHudMetrics(evaluation);
  const indicators = buildHudIndicators(evaluation);
  const chart = buildHudChart(evaluation);

  const entryPlan = {
    expectedNotionalSol: evaluation?.position?.expectedNotionalSol ?? null,
    expectedNotionalUsd: evaluation?.position?.expectedNotionalUsd ?? null,
    plannedNotionalSol: evaluation?.position?.plannedNotionalSol ?? null,
    plannedNotionalUsd: evaluation?.position?.plannedNotionalUsd ?? null,
  };

  try {
    bootyBox.insertBuyOpsEvaluation({
      tsMs: snapshot.ts,
      walletId: Number(snapshot.walletId),
      walletAlias: snapshot.walletAlias,
      tradeUuid: snapshot.tradeUuid || null,
      coinMint: snapshot.mint,
      symbol: evaluation.symbol || target?.symbol || null,

      targetStatus: target?.status || null,
      targetScore: target?.score ?? null,
      targetConfidence: target?.confidence ?? null,

      strategyName: evaluation?.strategy?.name || null,
      strategySource: evaluation?.strategy?.source || null,
      recommendation: evaluation?.recommendation || "hold",
      decision: snapshot.decision,
      regime: snapshot.regime?.status || null,

      qualifyFailedCount: evaluation?.qualify?.failedCount ?? 0,
      qualifyWorstSeverity: worstSeverity,
      gateFail,

      priceUsd: metrics?.priceUsd ?? null,
      liquidityUsd: metrics?.liquidityUsd ?? null,
      chartInterval: chart?.type ?? null,
      chartPoints: chart?.points ?? null,

      rsi: indicators?.rsi ?? null,
      macdHist: indicators?.macdHist ?? null,
      vwap: indicators?.vwap ?? null,
      warningsCount: Array.isArray(evaluation?.warnings)
        ? evaluation.warnings.length
        : 0,

      unrealUsd: metrics?.unrealizedUsd ?? null,
      totalUsd: metrics?.totalUsd ?? null,
      roiPct: metrics?.roiUnrealizedPct ?? null,

      reasons: snapshot.reasons,
      payload: {
        target: target || null,
        // Preserve strategy + entry sizing intent for later analysis.
        strategy: evaluation?.strategy || null,
        entryPlan,
        ...snapshot,
        evaluation: compactEvaluationForStorage(evaluation),
      },
    });
  } catch (err) {
    logger?.warn?.(
      `[buyOps] persist tick failed mint=${snapshot.mint || "n/a"} wallet=${
        snapshot.walletAlias || "n/a"
      }: ${err?.message || err}`
    );
  }
}

module.exports = {
  persistBuyOpsEvaluation,
};
