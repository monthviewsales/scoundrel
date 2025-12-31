'use strict';

/**
 * @typedef {'pass'|'fail'} GateOutcome
 */

/**
 * @typedef {Object} GateResult
 * @property {string} id
 * @property {'exit'|'degrade'|'trim'|'warn'} severityOnFail
 * @property {GateOutcome} outcome
 * @property {string[]} reasons
 */

/**
 * Safe getter for nested paths like "risk.top10Percent" or "derived.liquidityToPositionRatio".
 * @param {any} obj
 * @param {string} pathStr
 * @returns {any}
 */
function getPath(obj, pathStr) {
  if (!obj || !pathStr) return undefined;
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Evaluate a single gate against an evaluation snapshot.
 * Supports the gate types used in our v1 strategy JSONs.
 *
 * @param {any} evaluation
 * @param {any} gate
 * @returns {GateResult}
 */
function evalGate(evaluation, gate) {
  const id = gate?.id || 'gate.unknown';
  const severityOnFail = gate?.severityOnFail || 'warn';
  const reasons = [];

  const type = gate?.type;
  const params = gate?.params || {};

  let pass = true;

  if (type === 'warnings_forbidden_absent') {
    const forbidden = Array.isArray(params.forbidden) ? params.forbidden : [];
    const warnings = Array.isArray(evaluation?.warnings) ? evaluation.warnings : [];
    const hits = forbidden.filter((w) => warnings.includes(w));
    if (hits.length) {
      pass = false;
      reasons.push(`forbidden_warnings:${hits.join(',')}`);
    }
  } else if (type === 'warnings_contains_any') {
    const anyOf = Array.isArray(params.anyOf) ? params.anyOf : [];
    const warnings = Array.isArray(evaluation?.warnings) ? evaluation.warnings : [];
    const hits = anyOf.filter((w) => warnings.includes(w));
    if (hits.length) {
      pass = false;
      reasons.push(`warnings:${hits.join(',')}`);
    }
  } else if (type === 'field_equals') {
    const v = getPath(evaluation, params.path);
    if (v !== params.value) {
      pass = false;
      reasons.push(`expected:${params.path}==${String(params.value)} got:${String(v)}`);
    }
  } else if (type === 'number_lte') {
    const v = Number(getPath(evaluation, params.path));
    if (!Number.isFinite(v) || v > Number(params.max)) {
      pass = false;
      reasons.push(`expected:${params.path}<=${params.max} got:${Number.isFinite(v) ? v : 'n/a'}`);
    }
  } else if (type === 'number_gte') {
    const v = Number(getPath(evaluation, params.path));
    if (!Number.isFinite(v) || v < Number(params.min)) {
      pass = false;
      reasons.push(`expected:${params.path}>=${params.min} got:${Number.isFinite(v) ? v : 'n/a'}`);
    }
  } else if (type === 'pnl_lte') {
    const roi = Number(getPath(evaluation, 'derived.roiUnrealizedPct'));
    const maxPnlPct = Number(params.maxPnlPct);
    if (!Number.isFinite(roi) || roi > maxPnlPct) {
      pass = false;
      reasons.push(`expected:roiUnrealizedPct<=${maxPnlPct} got:${Number.isFinite(roi) ? roi : 'n/a'}`);
    }
  } else {
    // Unknown gate type: do not fail closed here (Phase 1.5).
    // We'll add strict validation once strategy execution is enabled.
    reasons.push(`unsupported_gate_type:${String(type)}`);
  }

  return {
    id,
    severityOnFail,
    outcome: pass ? 'pass' : 'fail',
    reasons,
  };
}

/**
 * Evaluate all qualify gates for a strategy.
 * @param {object} strategy
 * @param {any} evaluation
 * @returns {{ results: GateResult[], failed: GateResult[], worstSeverity: 'exit'|'degrade'|'trim'|'warn'|'none' }}
 */
function evalQualify(strategy, evaluation) {
  const gates = Array.isArray(strategy?.qualify?.gates) ? strategy.qualify.gates : [];
  const results = gates.map((g) => evalGate(evaluation, g));
  const failed = results.filter((r) => r.outcome === 'fail');

  /** @type {'exit'|'degrade'|'trim'|'warn'|'none'} */
  let worstSeverity = 'none';
  const rank = { none: 0, warn: 1, trim: 2, degrade: 3, exit: 4 };

  for (const f of failed) {
    const sev = f.severityOnFail || 'warn';
    if (rank[sev] > rank[worstSeverity]) worstSeverity = sev;
  }

  return { results, failed, worstSeverity };
}

/**
 * Choose a strategy for a position.
 * Prefer DB strategyName when available; otherwise infer by selecting the "strongest" strategy
 * whose qualify gates fully pass, in order FLASH -> HYBRID -> CAMPAIGN.
 *
 * @param {Object} position
 * @param {{ flash: object, hybrid: object, campaign: object }} docs
 * @param {any} evaluation
 * @returns {{ strategy: object, source: 'db'|'inferred', qualify: ReturnType<typeof evalQualify> }}
 */
function chooseStrategy(position, docs, evaluation) {
  const name = position?.strategyName ? String(position.strategyName).toUpperCase() : null;
  if (name) {
    if (name.includes('FLASH')) {
      return { strategy: docs.flash, source: 'db', qualify: evalQualify(docs.flash, evaluation) };
    }
    if (name.includes('CAMPAIGN')) {
      return { strategy: docs.campaign, source: 'db', qualify: evalQualify(docs.campaign, evaluation) };
    }
    if (name.includes('HYBRID')) {
      return { strategy: docs.hybrid, source: 'db', qualify: evalQualify(docs.hybrid, evaluation) };
    }
  }

  // Infer: pick first strategy that passes all gates (strictest first).
  const flashQ = evalQualify(docs.flash, evaluation);
  if (!flashQ.failed.length) return { strategy: docs.flash, source: 'inferred', qualify: flashQ };

  const hybridQ = evalQualify(docs.hybrid, evaluation);
  if (!hybridQ.failed.length) return { strategy: docs.hybrid, source: 'inferred', qualify: hybridQ };

  const campaignQ = evalQualify(docs.campaign, evaluation);
  return { strategy: docs.campaign, source: 'inferred', qualify: campaignQ };
}

/**
 * Translate qualify severity into a human-readable recommendation.
 * NOTE: This does NOT execute trades. It is HUD-only intelligence.
 *
 * @param {'exit'|'degrade'|'trim'|'warn'|'none'} worstSeverity
 * @returns {'hold'|'trim'|'exit'}
 */
function recommendAction(worstSeverity) {
  if (worstSeverity === 'exit') return 'exit';
  if (worstSeverity === 'trim') return 'trim';
  // degrade / warn / none → hold (with caution)
  return 'hold';
}

module.exports = {
  chooseStrategy,
  evalGate,
  evalQualify,
  getPath,
  recommendAction,
};
