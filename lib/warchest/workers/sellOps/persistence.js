"use strict";

const {
  buildEvaluationSnapshots,
  buildGateSummary,
} = require("../evaluations/persistenceUtils");

/**
 * Make an evaluation payload safe/compact for DB storage.
 * We store every tick, so avoid giant blobs (candles arrays).
 *
 * @param {any} evaluation
 * @returns {any}
 */
function compactEvaluationForStorage(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return evaluation;

  // Shallow clone to avoid mutating the live object.
  const out = Array.isArray(evaluation)
    ? evaluation.slice()
    : { ...evaluation };

  // Candle payload can be huge; keep chart metadata only.
  if (out.candles && Array.isArray(out.candles)) {
    delete out.candles;
    out._candlesOmitted = true;
  }

  // Some versions may nest candles under chart.
  if (
    out.chart &&
    typeof out.chart === "object" &&
    out.chart.candles &&
    Array.isArray(out.chart.candles)
  ) {
    out.chart = { ...out.chart };
    delete out.chart.candles;
    out.chart._candlesOmitted = true;
  }

  return out;
}

/**
 * Persist a SellOps evaluation payload (best-effort, non-fatal).
 * @param {Object} args
 * @param {any} args.bootyBox
 * @param {Object} args.summary
 * @param {any} args.snapshot
 * @param {any} args.hudPayload
 * @param {Object} args.logger
 * @param {string} args.walletAlias
 */
function persistSellOpsEvaluation({
  bootyBox,
  summary,
  snapshot,
  hudPayload,
  logger,
  walletAlias,
}) {
  if (!bootyBox || typeof bootyBox.insertEvaluation !== "function")
    return;
  if (!summary?.walletId || !summary?.tradeUuid) return;

  const evaluation = snapshot?.evaluation || {};
  const gateSummary = buildGateSummary(evaluation);
  const { metrics, indicators, chart, warningsCount } =
    buildEvaluationSnapshots(evaluation);

  if (!snapshot.riskControls && logger && typeof logger.debug === "function") {
    logger.debug(
      `[sellOps] persist tick missing riskControls wallet=${walletAlias} trade_uuid=${
        summary.tradeUuid || "n/a"
      } mint=${summary.mint || "n/a"}`
    );
  }

  try {
    bootyBox.insertEvaluation({
      opsType: "sellOps",
      tsMs: snapshot.ts,
      walletId: Number(summary.walletId),
      walletAlias: snapshot.walletAlias,
      tradeUuid: summary.tradeUuid,
      coinMint: summary.mint,
      symbol: hudPayload.symbol || evaluation?.symbol || null,

      strategyName: evaluation?.strategy?.name || null,
      strategySource: evaluation?.strategy?.source || null,
      recommendation: hudPayload.recommendation || "hold",
      decision: snapshot.decision,
      regime: snapshot.regime?.status || null,

      qualifyFailedCount: gateSummary.qualifyFailedCount ?? 0,
      qualifyWorstSeverity: gateSummary.qualifyWorstSeverity,
      gateFail: gateSummary.gateFail,

      priceUsd: metrics?.priceUsd ?? null,
      liquidityUsd: metrics?.liquidityUsd ?? null,
      chartInterval: chart?.type ?? null,
      chartPoints: chart?.points ?? null,

      rsi: indicators?.rsi ?? null,
      macdHist: indicators?.macdHist ?? null,
      vwap: indicators?.vwap ?? null,
      warningsCount,

      unrealUsd: metrics?.unrealizedUsd ?? null,
      totalUsd: metrics?.totalUsd ?? null,
      roiPct: metrics?.roiUnrealizedPct ?? null,

      // Store the human reasons (fast to query) and a compacted full payload for future autopsy/AI.
      reasons: snapshot.reasons,
      payload: {
        ...hudPayload,
        // Persist risk controls at the top level so fast-tick logic can restore state (e.g., trailing stop high-water).
        riskControls: snapshot.riskControls || null,
        // Keep a more complete snapshot for offline analysis without giant arrays.
        evaluation: compactEvaluationForStorage(snapshot.evaluation),
      },
    });
  } catch (err) {
    logger.warn(
      `[sellOps] persist tick failed wallet=${walletAlias} trade_uuid=${
        summary.tradeUuid || "n/a"
      } mint=${summary.mint || "n/a"}: ${err?.message || err}`
    );
  }
}

module.exports = {
  compactEvaluationForStorage,
  persistSellOpsEvaluation,
};
