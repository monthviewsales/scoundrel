"use strict";

const {
  buildHudChart,
  buildHudIndicators,
  buildHudMetrics,
} = require("../../../analysis/evaluationHudAdapter");

/**
 * Build gate failure metadata for persistence.
 *
 * @param {any} evaluation
 * @returns {{ qualifyFailedCount: number, qualifyWorstSeverity: string|null, gateFail: string|null }}
 */
function buildGateSummary(evaluation) {
  const qualifyResults = Array.isArray(evaluation?.qualify?.results)
    ? evaluation.qualify.results
    : [];
  const failedGates = qualifyResults.filter(
    (r) => r && (r.outcome === "fail" || r.pass === false)
  );
  const worstSeverity = evaluation?.qualify?.worstSeverity || null;
  const gateFail =
    (worstSeverity &&
      failedGates.find((g) => g.severityOnFail === worstSeverity)?.id) ||
    (failedGates[0] ? failedGates[0].id : null);

  return {
    qualifyFailedCount: evaluation?.qualify?.failedCount ?? failedGates.length,
    qualifyWorstSeverity: worstSeverity,
    gateFail,
  };
}

/**
 * Build indicator/metrics/chart snapshots for persistence.
 *
 * @param {any} evaluation
 * @returns {{ metrics: any, indicators: any, chart: any, warningsCount: number }}
 */
function buildEvaluationSnapshots(evaluation) {
  const metrics = buildHudMetrics(evaluation);
  const indicators = buildHudIndicators(evaluation);
  const chart = buildHudChart(evaluation);
  const warningsCount = Array.isArray(evaluation?.warnings)
    ? evaluation.warnings.length
    : 0;

  return { metrics, indicators, chart, warningsCount };
}

module.exports = {
  buildEvaluationSnapshots,
  buildGateSummary,
};
