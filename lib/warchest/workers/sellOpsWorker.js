#!/usr/bin/env node
'use strict';

const logger = require('../../logger');
const BootyBox = require('../../../db/src/adapters/sqlite');
const { createWorkerHarness } = require('./harness');
const { forkWorkerWithPayload } = require('./harness');
const { setup } = require('../client');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
const { buildEvaluation } = require('../../../db/src/services/evaluationService');
const path = require('path');
const fs = require('fs');

// Normalize sellOps logger: supports both factory-style (logger.sellOps()) and object-style (logger.sellOps)
const sellOpsLogger = typeof logger.sellOps === 'function' ? logger.sellOps() : logger.sellOps;

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
 * @typedef {Object} StrategyDoc
 * @property {string} schemaVersion
 * @property {string} strategyId
 * @property {string} name
 * @property {Object} [defaults]
 * @property {Object} [dataRequirements]
 * @property {Object} [qualify]
 * @property {Object[]} [qualify.gates]
 */

/**
 * Read and parse a JSON file from disk.
 * @param {string} filePath
 * @returns {any}
 */
function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Resolve absolute paths to strategy schemas.
 * @returns {{ flash: string, hybrid: string, campaign: string }}
 */
function getStrategySchemaPaths() {
  // This worker lives at: lib/warchest/workers/sellOpsWorker.js
  // Strategies live at:   lib/analysis/schemas/*.json
  const base = path.resolve(__dirname, '..', '..', 'analysis', 'schemas');
  return {
    flash: path.join(base, 'flashStrategy.v1.json'),
    hybrid: path.join(base, 'hybridStrategy.v1.json'),
    campaign: path.join(base, 'campaignStrategy.v1.json'),
  };
}

/**
 * Load strategy docs once per process.
 * @returns {{ flash: StrategyDoc, hybrid: StrategyDoc, campaign: StrategyDoc }}
 */
function loadStrategyDocs() {
  const p = getStrategySchemaPaths();
  return {
    flash: /** @type {StrategyDoc} */ (readJsonFile(p.flash)),
    hybrid: /** @type {StrategyDoc} */ (readJsonFile(p.hybrid)),
    campaign: /** @type {StrategyDoc} */ (readJsonFile(p.campaign)),
  };
}

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
 * @param {StrategyDoc} strategy
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
 * @param {PositionSummary} position
 * @param {{ flash: StrategyDoc, hybrid: StrategyDoc, campaign: StrategyDoc }} docs
 * @param {any} evaluation
 * @returns {{ strategy: StrategyDoc, source: 'db'|'inferred', qualify: ReturnType<typeof evalQualify> }}
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


const DEFAULT_POLL_MS = 60_000;
// Coin freshness guardrail (how stale is too stale)
const MAX_COIN_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_POOL_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_EVENTS_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_RISK_STALE_MS = 10 * 60 * 1000; // 10 minutes

// Phase 2 (first slice): lightweight trailing-stop watcher.
// This runs faster than the 60s evaluation loop and does NOT upsert anything.
// It uses SolanaTracker Data API getMultipleTokenPrices to watch open holdings.

const DEFAULT_TRAIL_POLL_MS = 5_000;
const MAX_PRICE_STALE_MS = 15_000; // ignore price points older than this (ms)
const DEFAULT_TRAIL_ACTIVATION_PCT = 10; // activate trailing stop after +10% from cost
const DEFAULT_TRAIL_PCT = 8; // trail by 8% from high-water
const DEFAULT_BREACH_CONFIRMATIONS = 2; // require N consecutive breaches before triggering
const DEFAULT_ACTION_DEBOUNCE_MS = 30_000; // minimum ms between stop actions per trade

// Hard stop loss (simple, Phase 2a): exit if unrealized ROI drops below -X%.
// NOTE: Trailing stop only protects winners; this protects losers.
const DEFAULT_HARD_STOP_LOSS_PCT = 25; // exit if ROI <= -25%


// Which event intervals we want on every evaluation snapshot


const DEFAULT_EVENT_INTERVALS = ['5m', '15m', '1h'];

// Strategy docs are versioned JSON stored in the repo.
// Load once at startup; if a file is missing or invalid JSON, fail fast (so we don't trade blind).
const STRATEGY_DOCS = loadStrategyDocs();

/**
 * @typedef {Object} WalletSpec
 * @property {string} alias - Wallet alias (required).
 * @property {string|null} [pubkey] - Wallet public key (optional for SellOps because positions are DB-driven).
 * @property {string|null} [color] - Optional color hint for HUD display.
 */

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
 * @typedef {Object} Regime
 * @property {'unknown'|'chop'|'trend_up'|'trend_down'|'bias_up'|'bias_down'} status
 * @property {string[]} reasons
 */

/**
 * @typedef {Object} EvaluationResult
 * @property {'hold'|'trim'|'exit'} decision - Phase 1 uses 'hold' only. Phase 2+ will return trim/exit.
 * @property {string[]} reasons - Human-readable reasons for decision (for HUD + logs).
 * @property {Object} evaluation - Full evaluation snapshot returned by evaluationService.
 */

/**
 * Send a structured IPC message to the parent process (warchest daemon/HUD).
 * No-op when not running under a worker harness.
 * @param {string} type
 * @param {any} payload
 */
function emitToParent(type, payload) {
  // Worker processes launched by the harness can send structured messages to the parent.
  // The parent (warchest daemon/HUD) can forward these to the HUD renderer.
  if (typeof process.send === 'function') {
    process.send({ type, payload });
  }
}

/**
 * Redact sensitive fields from an object for safe logging.
 * @param {any} obj
 * @returns {any}
 */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && /(key|secret|token|password|private)/i.test(k)) {
      out[k] = v ? '[redacted]' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Make an evaluation payload safe/compact for DB storage.
 * We store every tick, so avoid giant blobs (candles arrays).
 *
 * @param {any} evaluation
 * @returns {any}
 */
function compactEvaluationForStorage(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return evaluation;

  // Shallow clone to avoid mutating the live object.
  const out = Array.isArray(evaluation) ? evaluation.slice() : { ...evaluation };

  // Candle payload can be huge; keep chart metadata only.
  if (out.candles && Array.isArray(out.candles)) {
    delete out.candles;
    out._candlesOmitted = true;
  }

  // Some versions may nest candles under chart.
  if (out.chart && typeof out.chart === 'object' && out.chart.candles && Array.isArray(out.chart.candles)) {
    out.chart = { ...out.chart };
    delete out.chart.candles;
    out.chart._candlesOmitted = true;
  }

  return out;
}

/**
 * Normalize a wallet payload into the internal WalletSpec shape.
 * @param {any} payloadWallet
 * @returns {WalletSpec}
 */
function normalizeWallet(payloadWallet) {
  const wallet = payloadWallet || {};
  const alias = wallet && (wallet.alias || wallet.walletAlias || wallet.name);
  const pubkey = wallet && (wallet.pubkey || wallet.wallet || wallet.address);

  if (!alias) {
    throw new Error('sellOps requires wallet alias');
  }

  // pubkey is optional for SellOps (DB-driven), but keep it if provided.
  return {
    alias: String(alias).trim(),
    pubkey: pubkey ? String(pubkey).trim() : null,
    color: wallet.color || null,
  };
}


/**
 * Convert a DB row from BootyBox.loadOpenPositions() into a PositionSummary.
 * @param {any} row
 * @returns {PositionSummary}
 */
function toPositionSummary(row) {
  return {
    positionId: row.position_id,
    walletId: row.wallet_id,
    walletAlias: row.wallet_alias,
    mint: row.coin_mint,
    tradeUuid: row.trade_uuid,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    openAt: row.open_at,
    closedAt: row.closed_at,
    lastTradeAt: row.last_trade_at,
    lastUpdatedAt: row.last_updated_at,
    entryTokenAmount: row.entry_token_amount,
    currentTokenAmount: row.current_token_amount,
    totalTokensBought: row.total_tokens_bought,
    totalTokensSold: row.total_tokens_sold,
    entryPriceSol: row.entry_price_sol,
    entryPriceUsd: row.entry_price_usd,
    lastPriceSol: row.last_price_sol,
    lastPriceUsd: row.last_price_usd,
    source: row.source,
  };
}

/**
 * Run autopsy for a recently-closed position.
 *
 * NOTE: We intentionally require `wallet.pubkey` and `position.tradeUuid` to avoid
 * producing ambiguous artifacts or running expensive analysis without identity.
 *
 * @param {Object} args
 * @param {PositionSummary} args.position
 * @param {WalletSpec} args.wallet
 * @param {NodeJS.ProcessEnv} args.workerEnv
 * @param {Function} [args.runAutopsy] - Optional injected autopsy runner (tests).
 * @returns {Promise<any|null>}
 */
async function runAutopsyForClosedPosition({ position, wallet, workerEnv, runAutopsy }) {
  if (!position || !wallet) return null;
  if (!wallet.pubkey) {
    sellOpsLogger.warn(`[sellOps] autopsy skipped for ${position.mint || 'mint?'}: missing wallet pubkey`);
    return null;
  }
  if (!position.tradeUuid) {
    sellOpsLogger.warn(`[sellOps] autopsy skipped for ${position.mint || 'mint?'}: missing trade_uuid`);
    return null;
  }

  if (typeof runAutopsy === 'function') {
    return runAutopsy({
      walletAddress: wallet.pubkey,
      mint: position.mint,
      walletLabel: wallet.alias,
    });
  }

  const workerPath = path.join(__dirname, 'autopsyWorker.js');
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
 * Compute a lightweight market regime label from evaluation indicators.
 *
 * This is intentionally simple and explainable. Strategies should treat this as
 * supporting context, not a single source of truth.
 *
 * @param {any} evaluation
 * @returns {Regime}
 */
function computeRegime(evaluation) {
  const ind = evaluation?.indicators || null;
  const chart = evaluation?.chart || null;

  if (!ind || !chart) {
    return { status: 'unknown', reasons: ['missing_indicators_or_chart'] };
  }

  const last = Number.isFinite(Number(ind.lastClose)) ? Number(ind.lastClose) : null;
  const emaFast = Number.isFinite(Number(ind.emaFast)) ? Number(ind.emaFast) : null;
  const emaSlow = Number.isFinite(Number(ind.emaSlow)) ? Number(ind.emaSlow) : null;
  const rsi = Number.isFinite(Number(ind.rsi)) ? Number(ind.rsi) : null;
  const atr = Number.isFinite(Number(ind.atr)) ? Number(ind.atr) : null;
  const vwap = Number.isFinite(Number(ind.vwap)) ? Number(ind.vwap) : null;
  const macd = ind.macd && typeof ind.macd === 'object' ? ind.macd : null;

  const reasons = [];

  // Trend
  let trend = 'unknown';
  if (emaFast != null && emaSlow != null) {
    if (emaFast > emaSlow) trend = 'up';
    else if (emaFast < emaSlow) trend = 'down';
    else trend = 'flat';
    reasons.push(`trend:${trend}`);
  }

  // Momentum (MACD)
  let momentum = 'unknown';
  if (macd && Number.isFinite(Number(macd.hist))) {
    const h = Number(macd.hist);
    momentum = h > 0 ? 'bullish' : h < 0 ? 'bearish' : 'neutral';
    reasons.push(`macd:${momentum}`);
  }

  // RSI bands
  if (rsi != null) {
    if (rsi >= 70) reasons.push('rsi:overbought');
    else if (rsi <= 30) reasons.push('rsi:oversold');
    else reasons.push('rsi:mid');
  }

  // Price vs VWAP
  if (last != null && vwap != null) {
    if (last > vwap) reasons.push('price>vwap');
    else if (last < vwap) reasons.push('price<vwap');
    else reasons.push('price=vwap');
  }

  // Volatility (ATR relative)
  if (last != null && atr != null && last !== 0) {
    const atrPct = (atr / last) * 100;
    if (Number.isFinite(atrPct)) {
      reasons.push(`atrPct:${atrPct.toFixed(2)}`);
    }
  }

  // Regime label (simple)
  let status = 'chop';
  if (trend === 'up' && momentum === 'bullish') status = 'trend_up';
  else if (trend === 'down' && momentum === 'bearish') status = 'trend_down';
  else if (trend === 'up' && momentum !== 'bearish') status = 'bias_up';
  else if (trend === 'down' && momentum !== 'bullish') status = 'bias_down';

  return { status, reasons };
}


/**
 * Build a full evaluation snapshot and return a decision scaffold.
 *
 * Phase 1 (current): always returns decision='hold' and emits rich diagnostics.
 * Phase 2+: strategy engine will:
 *  - resolve/assign strategy per position (DB strategy_id/strategy_name or inference)
 *  - apply eligibility gates (risk/structure + liquidity + freshness)
 *  - apply exit logic (partials, trailing stops, hard invalidations)
 *  - optionally recommend sizing and/or enforce post-entry de-risk trims
 *
 * @param {Object} args
 * @param {PositionSummary} args.position
 * @param {any} args.db
 * @param {any} args.dataClient
 * @param {string[]} [args.eventIntervals]
 * @param {any} [args.payload]
 * @returns {Promise<EvaluationResult>}
 */
// --- Full evaluation snapshot ---
async function evaluatePosition({ position, db, dataClient, eventIntervals, payload }) {
  const reasons = [];

  // Build a complete, DB-backed snapshot (shared across apps)
  const { evaluation, warnings } = await buildEvaluation({
    db,
    position,
    dataClient,
    eventIntervals: eventIntervals || DEFAULT_EVENT_INTERVALS,
    freshness: {
      coin: MAX_COIN_STALE_MS,
      pool: MAX_POOL_STALE_MS,
      events: MAX_EVENTS_STALE_MS,
      risk: MAX_RISK_STALE_MS,
    },
    ohlcv: {
      type: payload?.ohlcvType || '1m',
      lookbackMs: payload?.ohlcvLookbackMs || 60 * 60 * 1000, // 60m default
      fastCache: true,
      removeOutliers: true,
    },
    indicators: {
      // VWAP over last N candles if provided; otherwise full lookback
      vwapPeriods: payload?.vwapPeriods ?? null,
    },
    includeCandles: Boolean(payload?.includeCandles),
  });

  // Ensure warnings are present on the evaluation object (strategy engine expects them).
  // buildEvaluation returns `warnings` separately for historical compatibility.
  if (evaluation && !Array.isArray(evaluation.warnings)) evaluation.warnings = warnings || [];

  // Best-effort symbol for logs/HUD (prefer evaluation coin meta, then position fields).
  const symbol =
    (evaluation && (evaluation.symbol || evaluation.coin?.symbol || evaluation.token?.symbol)) ||
    position?.symbol ||
    position?.coinSymbol ||
    null;

  // Attach symbol onto the evaluation snapshot so downstream doesn't need to re-derive it.
  if (evaluation && symbol && !evaluation.symbol) evaluation.symbol = symbol;

  // Strategy selection + qualify evaluation (Phase 1.5: observe only).
  const chosen = chooseStrategy(position, STRATEGY_DOCS, evaluation);
  const qualify = chosen.qualify;

  // Attach strategy metadata and gate outcomes for HUD, logs, and eventual autopsy embedding.
  evaluation.strategy = {
    strategyId: chosen.strategy.strategyId,
    schemaVersion: chosen.strategy.schemaVersion,
    name: chosen.strategy.name,
    source: chosen.source,
  };
  evaluation.qualify = {
    worstSeverity: qualify.worstSeverity,
    failedCount: qualify.failed.length,
    results: qualify.results,
  };

  // Non-executing recommendation derived from strategy qualify results.
  // This is surfaced to the HUD only.
  const recommendation = recommendAction(qualify.worstSeverity);
  evaluation.recommendation = recommendation;
  reasons.push(`recommend:${recommendation}`);

  // Add human-readable reasons for visibility (no execution yet).
  reasons.push(`strategy:${evaluation.strategy.name}`);
  reasons.push(`strategySource:${evaluation.strategy.source}`);
  if (qualify.failed.length) {
    reasons.push(`qualifyFailed:${qualify.failed.length}`);
    for (const f of qualify.failed.slice(0, 5)) {
      reasons.push(`gateFail:${f.id}:${f.severityOnFail}`);
    }
    if (qualify.worstSeverity === 'degrade') {
      reasons.push('posture:degrade');
    }
  } else {
    reasons.push('qualify:pass');
  }

  // For now we do not take action. Phase 2 will score and pick buy/hold/sell.
  const decision = 'hold';

  if (!warnings || !warnings.length) {
    reasons.push('evaluation_ready');
  } else {
    reasons.push('evaluation_partial');
  }

  return { decision, reasons, evaluation };
}

/**
 * Safely pull trailing stop config from a strategy doc.
 * We keep this permissive because schemas may evolve.
 * @param {StrategyDoc} strategy
 * @returns {{ activationPct: number, trailPct: number, pollMs: number, breachConfirmations: number, actionDebounceMs: number, hardStopLossPct: number }}
 */
function getTrailingStopConfig(strategy) {
  const d = (strategy && strategy.defaults) || {};
  // Allow a few possible shapes without being brittle.
  const ts = (d && (d.trailingStop || d.trailing_stop || d.trailing)) || {};

  const activationPct = Number.isFinite(Number(ts.activationPct)) ? Number(ts.activationPct) : DEFAULT_TRAIL_ACTIVATION_PCT;
  const trailPct = Number.isFinite(Number(ts.trailPct)) ? Number(ts.trailPct) : DEFAULT_TRAIL_PCT;
  const pollMs = Number.isFinite(Number(ts.pollMs)) ? Number(ts.pollMs) : DEFAULT_TRAIL_POLL_MS;
  const breachConfirmations = Number.isFinite(Number(ts.breachConfirmations))
    ? Number(ts.breachConfirmations)
    : DEFAULT_BREACH_CONFIRMATIONS;
  const actionDebounceMs = Number.isFinite(Number(ts.actionDebounceMs)) ? Number(ts.actionDebounceMs) : DEFAULT_ACTION_DEBOUNCE_MS;
  const hardStopLossPct = Number.isFinite(Number(ts.hardStopLossPct))
    ? Number(ts.hardStopLossPct)
    : Number.isFinite(Number(d.hardStopLossPct))
      ? Number(d.hardStopLossPct)
      : DEFAULT_HARD_STOP_LOSS_PCT;

  return {
    activationPct,
    trailPct,
    pollMs,
    breachConfirmations,
    actionDebounceMs,
    hardStopLossPct,
  };
}

/**
 * Best-effort cost basis in USD for a position.
 * Prefer evaluation.pnl.avg_cost_usd, then position.entryPriceUsd.
 * @param {PositionSummary} position
 * @param {any} evaluation
 * @returns {number|null}
 */
function resolveAvgCostUsd(position, evaluation) {
  const fromEval = Number(getPath(evaluation, 'pnl.avg_cost_usd'));
  if (Number.isFinite(fromEval) && fromEval > 0) return fromEval;

  const fromPos = Number(position?.entryPriceUsd);
  if (Number.isFinite(fromPos) && fromPos > 0) return fromPos;

  return null;
}

/**
 * Create a SellOps controller.
 *
 * Payload contract:
 * - payload.wallet: { alias|walletAlias|name, pubkey? }
 * - payload.pollIntervalMs?: number (defaults to 60s)
 * - payload.statusDir?: optional status dir forwarded to setup()
 */
function createSellOpsController(
  payload,
  tools = {},
  log = sellOpsLogger
) {
  const wallet = normalizeWallet(payload.wallet || payload);
  const pollIntervalMs = payload.pollIntervalMs || DEFAULT_POLL_MS;

  const track = typeof tools.track === 'function' ? tools.track : () => {};
  const workerEnv = tools.env || process.env;

  // Ensure BootyBox sqlite adapter/context is initialized once per worker process.
  try {
    if (typeof BootyBox.init === 'function') BootyBox.init();
  } catch (err) {
    log.warn(`[sellOps] BootyBox.init() failed: ${err?.message || err}`);
  }

  let client = tools.client || null;
  const ownsClient = !client;
  let db = null;
  let dataClient = null;
  let previousOpenPositions = new Map(); // trade_uuid -> position summary

  // Trailing-stop state (in-memory only)
  const costUsdByTradeUuid = new Map(); // tradeUuid -> avg cost USD
  const trailingStateByTradeUuid = new Map();
  // tradeUuid -> {
  //   active: boolean,
  //   activationPct: number,
  //   trailPct: number,
  //   highWaterUsd: number,
  //   stopUsd: number,
  //   breachCount: number,
  //   lastPriceUsd: number,
  //   lastPriceTsMs: number,
  //   lastActionTsMs: number,
  // }
  let trailingTimer = null;
  let lastTrailingHeartbeatTsMs = 0;
  let trailingRunning = false;

  // TODO(strategy-state): Maintain per-position strategy state keyed by tradeUuid.
  // Suggested shape:
  //   const strategyStateByTradeUuid = new Map(); // tradeUuid -> { activeStrategy, assignedAt, lastSwitchAt, switchCount, notes }
  // Keep this in-memory first; later persist strategy transitions to BootyBox for autopsy + HUD explainability.
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
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      trailingRunning = false;

      if (dataClient && typeof dataClient.close === 'function') {
        try {
          await dataClient.close();
        } catch (err) {
          log.warn(`[sellOps] data client close failed: ${err?.message || err}`);
        }
      }

      if (client && ownsClient && typeof client.close === 'function') {
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
      stopReason = reason || 'stopped';

      const result = {
        status: 'stopped',
        stopReason,
        walletAlias: wallet.alias,
      };

      await cleanup();
      trailingRunning = false;
      resolve(result);
    }

    /**
     * Start a fast trailing-stop loop that watches open positions.
     * No DB writes. Best-effort only; errors never stop SellOps.
     */
    function ensureTrailingLoopStarted() {
      if (trailingRunning) return;
      trailingRunning = true;

      const docsForDefaults = STRATEGY_DOCS?.flash || null;
      const defaults = getTrailingStopConfig(docsForDefaults);

      const hardStopLossPct = Number.isFinite(Number(payload?.hardStopLossPct))
        ? Number(payload.hardStopLossPct)
        : defaults.hardStopLossPct;

      const basePollMs = Number.isFinite(Number(payload?.trailingPollMs)) ? Number(payload.trailingPollMs) : defaults.pollMs;
      const pollMs = Math.max(1_000, basePollMs); // don’t go crazy

      async function trailingTick() {
        if (stopped) return;

        try {
          if (!dataClient || typeof dataClient.getMultipleTokenPrices !== 'function') {
            // Data client not ready yet (or method missing) – retry.
            return;
          }

          // Build a de-duped list of open mints with non-zero token amount.
          let skipMissingIds = 0;
          let skipZeroAmt = 0;
          let skipDuplicateMint = 0;
          let skipBadMint = 0;
          const mints = [];
          const seen = new Set();
          for (const pos of previousOpenPositions.values()) {
            if (!pos || !pos.mint || !pos.tradeUuid) {
              skipMissingIds += 1;
              continue;
            }
            const amtRaw = pos.currentTokenAmount;
            const amt = Number(amtRaw);
            // If currentTokenAmount is missing/null, still watch price (position is open).
            // Only skip when we have a finite numeric amount that is <= 0.
            if (Number.isFinite(amt) && amt <= 0) {
              skipZeroAmt += 1;
              continue;
            }
            if (seen.has(pos.mint)) {
              skipDuplicateMint += 1;
              continue;
            }
            seen.add(pos.mint);
            mints.push(pos.mint);
          }

          const mintList = Array.isArray(mints)
            ? mints.filter((m) => {
                if (typeof m === 'string' && m.trim().length > 0) return true;
                skipBadMint += 1;
                return false;
              })
            : [];

          if (!mintList.length) {
            sellOpsLogger.debug(
              `[sellOps] trailing-stop mintList empty wallet=${wallet.alias} openPositions=${previousOpenPositions.size} ` +
                `skipMissingIds=${skipMissingIds} skipZeroAmt=${skipZeroAmt} skipDuplicateMint=${skipDuplicateMint} skipBadMint=${skipBadMint}`
            );

            const now = Date.now();
            // Throttle to avoid spamming the HUD.
            if (now - lastTrailingHeartbeatTsMs >= 15_000) {
              lastTrailingHeartbeatTsMs = now;
              emitToParent('sellOps:heartbeat', {
                ts: now,
                walletAlias: wallet.alias,
                status: 'trailing_stop_idle',
                openPositions: previousOpenPositions.size,
                watchedMints: 0,
                activeStops: 0,
                note: 'no eligible mints to watch',
              });
            }

            // Nothing to watch yet.
            return;
          }

          sellOpsLogger.debug(`[sellOps] trailing-stop price fetch wallet=${wallet.alias} mintListLen=${mintList.length} mints=${mintList.join(',')}`);
          const prices = await dataClient.getMultipleTokenPrices(mintList);
          const now = Date.now();

          // Summary counters for HUD visibility (no DB writes).
          let watchedCount = 0;
          let activeStops = 0;
          let pricedCount = 0;
          let stalePriceSkips = 0;
          let missingCostSkips = 0;

          for (const pos of previousOpenPositions.values()) {
            if (!pos || !pos.mint || !pos.tradeUuid) continue;
            const mint = pos.mint;
            const tradeUuid = pos.tradeUuid;
            watchedCount += 1;

            const priceObj = prices && prices[mint] ? prices[mint] : null;
            const priceUsd = priceObj && Number.isFinite(Number(priceObj.price)) ? Number(priceObj.price) : null;
            const lastUpdated = priceObj && Number.isFinite(Number(priceObj.lastUpdated)) ? Number(priceObj.lastUpdated) : null;

            if (priceUsd != null && priceUsd > 0) pricedCount += 1;
            if (lastUpdated != null && now - lastUpdated > MAX_PRICE_STALE_MS) {
              stalePriceSkips += 1;
              continue; // stale price point
            }
            if (priceUsd == null || priceUsd <= 0) continue;

            // Resolve or initialize config/state.
            const existing = trailingStateByTradeUuid.get(tradeUuid) || null;
            const activationPct = existing?.activationPct ?? defaults.activationPct;
            const trailPct = existing?.trailPct ?? defaults.trailPct;
            const breachConfirmations = defaults.breachConfirmations;
            const actionDebounceMs = defaults.actionDebounceMs;

            const costUsd = costUsdByTradeUuid.get(tradeUuid) || null;
            if (!costUsd || !Number.isFinite(Number(costUsd)) || Number(costUsd) <= 0) {
              // If we don't know cost, we can't do ROI-based trailing. Skip.
              missingCostSkips += 1;
              continue;
            }

            const roiPct = ((priceUsd / Number(costUsd)) - 1) * 100;

            /** @type {any} */
            const state = existing || {
              active: false,
              activationPct,
              trailPct,
              highWaterUsd: priceUsd,
              stopUsd: 0,
              breachCount: 0,
              lastPriceUsd: priceUsd,
              lastPriceTsMs: now,
              lastActionTsMs: 0,
            };

            // Hard stop-loss check: BEFORE any activation/trailing logic.
            // Phase 2a: hard stop loss. If we're down more than X%, trigger an exit.
            // This is independent of trailing-stop activation (which only arms on winners).
            const stopLossEligible = roiPct <= -Math.abs(Number(hardStopLossPct));
            const stopLossDebounceOk = now - (state.lastActionTsMs || 0) >= actionDebounceMs;

            if (stopLossEligible && stopLossDebounceOk) {
              state.lastActionTsMs = now;

              const actionPayload = {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                costUsd,
                roiPct,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
                breachCount: state.breachCount,
                breachConfirmations,
                action: 'exit',
                reason: 'stop_loss',
                hardStopLossPct,
              };

              emitToParent('sellOps:stopLoss:trigger', actionPayload);

              // Best-effort: execute via swapWorker.
              try {
                const swapWorkerPath = path.join(__dirname, 'swapWorker.js');

                const amtNum = Number(pos.currentTokenAmount);
                const amountDecimal = Number.isFinite(amtNum) && amtNum > 0 ? String(amtNum) : null;

                if (!amountDecimal) {
                  sellOpsLogger.warn(
                    `[sellOps] stop-loss swap payload missing amountDecimal; falling back to percent-only wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint} currentTokenAmount=${pos.currentTokenAmount}`
                  );
                }

                await forkWorkerWithPayload(swapWorkerPath, {
                  payload: {
                    walletAlias: wallet.alias,
                    mint,
                    tradeUuid,
                    side: 'sell',

                    ...(amountDecimal ? { amountDecimal, amount: amountDecimal, fromAmountDecimal: amountDecimal } : {}),

                    percent: 1,
                    sellPercent: 100,
                    sellPct: 100,
                    sellAll: true,
                    isSellAll: true,

                    reason: 'stop_loss',
                    source: 'sellOpsWorker',
                    hardStopLossPct,
                  },
                  env: workerEnv,
                  timeoutMs: 0,
                });
              } catch (err) {
                sellOpsLogger.warn(
                  `[sellOps] stop-loss execution failed wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint}: ${err?.message || err}`
                );
              }

              // Save state and skip further trailing logic this tick.
              trailingStateByTradeUuid.set(tradeUuid, state);
              continue;
            }

            // Track the latest price.
            state.lastPriceUsd = priceUsd;
            state.lastPriceTsMs = now;

            // Activate once we’re in profit enough.
            if (!state.active && roiPct >= state.activationPct) {
              state.active = true;
              state.highWaterUsd = priceUsd;
              state.stopUsd = priceUsd * (1 - state.trailPct / 100);
              state.breachCount = 0;

              emitToParent('sellOps:trailingStop:armed', {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                costUsd,
                roiPct,
                activationPct: state.activationPct,
                trailPct: state.trailPct,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
              });
            }

            if (!state.active) {
              trailingStateByTradeUuid.set(tradeUuid, state);
              continue;
            }
            activeStops += 1;

            // Update high-water and stop.
            if (priceUsd > state.highWaterUsd) {
              state.highWaterUsd = priceUsd;
              state.stopUsd = state.highWaterUsd * (1 - state.trailPct / 100);
              state.breachCount = 0;

              emitToParent('sellOps:trailingStop:high', {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
              });
            }

            // Breach tracking.
            if (state.stopUsd > 0 && priceUsd <= state.stopUsd) {
              state.breachCount += 1;
            } else {
              state.breachCount = 0;
            }

            // Trigger.
            const eligible = state.breachCount >= breachConfirmations;
            const debounceOk = now - (state.lastActionTsMs || 0) >= actionDebounceMs;

            if (eligible && debounceOk) {
              state.lastActionTsMs = now;

              const actionPayload = {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                costUsd,
                roiPct,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
                breachCount: state.breachCount,
                breachConfirmations,
                action: 'exit',
                reason: 'trailing_stop',
              };

              emitToParent('sellOps:trailingStop:trigger', actionPayload);

              // Best-effort: try to execute via swapWorker if present.
              // swapWorker expects a concrete amount for sell-side in some versions.
              // Prefer the current token amount from the open position; fall back to 100% semantics.
              try {
                const swapWorkerPath = path.join(__dirname, 'swapWorker.js');

                const amtNum = Number(pos.currentTokenAmount);
                const amountDecimal = Number.isFinite(amtNum) && amtNum > 0 ? String(amtNum) : null;

                if (!amountDecimal) {
                  sellOpsLogger.warn(
                    `[sellOps] trailing-stop swap payload missing amountDecimal; falling back to percent-only wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint} currentTokenAmount=${pos.currentTokenAmount}`
                  );
                }

                await forkWorkerWithPayload(swapWorkerPath, {
                  payload: {
                    walletAlias: wallet.alias,
                    mint,
                    tradeUuid,

                    // Ask swapWorker for a full exit.
                    side: 'sell',

                    // Provide an explicit amount when possible (some swapWorker versions require it).
                    ...(amountDecimal ? { amountDecimal, amount: amountDecimal, fromAmountDecimal: amountDecimal } : {}),

                    // Also include percent-based fields for compatibility across versions.
                    percent: 1, // 1.0 = 100% (fractional)
                    sellPercent: 100, // 100 = 100% (percent)
                    sellPct: 100, // legacy alias
                    sellAll: true,
                    isSellAll: true,

                    // Provide context for logging/alerts.
                    reason: 'trailing_stop',
                    source: 'sellOpsWorker',
                  },
                  env: workerEnv,
                  timeoutMs: 0,
                });
              } catch (err) {
                sellOpsLogger.warn(
                  `[sellOps] trailing-stop execution failed wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint}: ${err?.message || err}`
                );
              }
            }

            trailingStateByTradeUuid.set(tradeUuid, state);
          }

          // Emit a throttled heartbeat so the HUD/alerts show the fast loop is alive,
          // even when no stop is armed (e.g., position is underwater).
          if (now - lastTrailingHeartbeatTsMs >= 15_000) {
            lastTrailingHeartbeatTsMs = now;
            emitToParent('sellOps:heartbeat', {
              ts: now,
              walletAlias: wallet.alias,
              status: activeStops > 0 ? 'trailing_stop_armed' : 'trailing_stop',
              openPositions: previousOpenPositions.size,
              watchedMints: mintList.length,
              watchedPositions: watchedCount,
              pricedMints: pricedCount,
              activeStops,
              stalePriceSkips,
              missingCostSkips,
              lastPriceTsMs: now,
            });
          }
        } catch (err) {
          sellOpsLogger.warn(`[sellOps] trailing-stop tick failed wallet=${wallet.alias}: ${err?.message || err}`);
        } finally {
          if (!stopped) {
            trailingTimer = setTimeout(trailingTick, pollMs);
          }
        }
      }

      // Kick off.
      trailingTimer = setTimeout(trailingTick, pollMs);
      sellOpsLogger.info(`[sellOps] trailing-stop loop started wallet=${wallet.alias} pollMs=${pollMs}`);
    }

    async function tick() {
      if (stopped) return;

      const tickStartedAt = Date.now();
      try {
        // Ensure client/db are available
        if (!client) {
          // Prefer explicit payload override, otherwise fall back to the normal SolanaTracker env vars.
          const resolvedDataEndpoint =
            (payload?.dataEndpoint && String(payload.dataEndpoint).trim()) ||
            (workerEnv.SOLANATRACKER_URL && String(workerEnv.SOLANATRACKER_URL).trim()) ||
            (workerEnv.SOLANATRACKER_DATA_ENDPOINT && String(workerEnv.SOLANATRACKER_DATA_ENDPOINT).trim()) ||
            (workerEnv.WARCHEST_DATA_ENDPOINT && String(workerEnv.WARCHEST_DATA_ENDPOINT).trim()) ||
            undefined;

          sellOpsLogger.debug(
            `[sellOps] calling setup() walletSpecs[0]=${JSON.stringify({
              alias: wallet.alias,
              pubkey: wallet.pubkey ? String(wallet.pubkey).slice(0, 6) + '…' : null,
              color: wallet.color || null,
            })} dataEndpoint=${
              (payload?.dataEndpoint || workerEnv.SOLANATRACKER_URL || workerEnv.SOLANATRACKER_DATA_ENDPOINT || workerEnv.WARCHEST_DATA_ENDPOINT)
                ? 'set'
                : 'missing'
            }`
          );

          client = await setup({
            walletSpecs: [wallet],
            mode: 'daemon',
            statusDir: payload.statusDir,
            // Allow setup() to use its own defaults if undefined.
            ...(resolvedDataEndpoint ? { dataEndpoint: resolvedDataEndpoint } : {}),
          });
          sellOpsLogger.debug(`[sellOps] setup() returned client keys=${Object.keys(client || {}).join(',') || 'none'}`);
        }
        // SQLite-only: DB should come from BootyBox sqlite context (or injected tools.db)
        const ctx = BootyBox.modules && BootyBox.modules.context ? BootyBox.modules.context : null;

        // Prefer injected db (tests), otherwise use BootyBox context.
        if (!db) {
          db = tools.db || (ctx && ctx.db) || null;
        }

        // If context exposes a getter, fall back to it.
        if (!db && ctx && typeof ctx.getDb === 'function') {
          try {
            db = ctx.getDb();
          } catch (err) {
            sellOpsLogger.warn(`[sellOps] ctx.getDb() failed: ${err?.message || err}`);
          }
        }

        sellOpsLogger.debug(
          `db resolved source=${tools.db ? 'tools.db' : db ? 'bootyboxContext' : 'none'} ` +
            `keys=${Object.keys(db || {}).slice(0, 15).join(',') || 'none'} ` +
            `hasAll=${db && typeof db.all === 'function'} hasPrepare=${db && typeof db.prepare === 'function'}`
        );

        // Data API client: let the client load defaults from env (safeDotenv + context).
        // This keeps SellOps consistent with the rest of Scoundrel and avoids harness-only env names.
        if (!dataClient) {
          dataClient = tools.dataClient || createSolanaTrackerDataClient({ logger: log });
          log.debug('[sellOps] dataClient created (defaults from env)');
        }

        const { rows } = await BootyBox.loadOpenPositions(wallet.alias);
        const summaries = rows.map(toPositionSummary);
        const currentPositions = new Map();
        for (const summary of summaries) {
          if (!summary.tradeUuid) continue;
          currentPositions.set(summary.tradeUuid, summary);
        }

        const closedPositions = [];
        for (const [tradeUuid, summary] of previousOpenPositions.entries()) {
          if (!currentPositions.has(tradeUuid) && !autopsiedTradeUuids.has(tradeUuid)) {
            closedPositions.push(summary);
          }
        }

        // Prune trailing-stop state for positions that are no longer open.
        for (const tradeUuid of trailingStateByTradeUuid.keys()) {
          if (!currentPositions.has(tradeUuid)) {
            trailingStateByTradeUuid.delete(tradeUuid);
            costUsdByTradeUuid.delete(tradeUuid);
          }
        }

        previousOpenPositions = currentPositions;

        // Start fast trailing-stop watcher only after we've loaded positions at least once.
        // This avoids a race where the loop fires before we have any open positions cached.
        ensureTrailingLoopStarted();

        if (!rows.length) {
          sellOpsLogger.info(`[sellOps] wallet=${wallet.alias} no open positions; rechecking in ${Math.round(pollIntervalMs / 1000)}s`);
          emitToParent('sellOps:heartbeat', {
            ts: Date.now(),
            walletAlias: wallet.alias,
            status: 'idle',
            openPositions: 0,
            nextTickMs: pollIntervalMs,
          });
        } else {
          // Evaluate each open position every tick (per your spec).
          // We group logs by trade_uuid if present.
          sellOpsLogger.info(`[sellOps] wallet=${wallet.alias} evaluating ${rows.length} open position(s)`);

          for (const summary of summaries) {
            const evalResult = await evaluatePosition({
              position: summary,
              db,
              dataClient,
              eventIntervals: payload.eventIntervals || DEFAULT_EVENT_INTERVALS,
              payload,
            });
            // Cache cost basis (USD) for fast trailing-stop calculations.
            try {
              const costUsd = resolveAvgCostUsd(summary, evalResult.evaluation);
              if (summary.tradeUuid && costUsd && Number.isFinite(Number(costUsd)) && Number(costUsd) > 0) {
                costUsdByTradeUuid.set(summary.tradeUuid, Number(costUsd));
              }
            } catch (_) {
              // ignore
            }

            const regime = computeRegime(evalResult.evaluation);

            // Final assembled snapshot (in-memory for now; persistence later)
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

            // Emit a compact payload for HUD display (avoid huge candle arrays).
            const indForHud = snapshot.evaluation?.indicators || {};
            const hudPayload = {
              ts: snapshot.ts,
              walletAlias: snapshot.walletAlias,
              tradeUuid: snapshot.tradeUuid,
              mint: snapshot.mint,
              symbol: snapshot.evaluation?.symbol || null,
              strategy: snapshot.evaluation?.strategy || null,
              qualify: snapshot.evaluation?.qualify
                ? { worstSeverity: snapshot.evaluation.qualify.worstSeverity, failedCount: snapshot.evaluation.qualify.failedCount }
                : null,
              decision: snapshot.decision,
              recommendation: snapshot.evaluation?.recommendation || 'hold',
              reasons: snapshot.reasons,
              regime: snapshot.regime,
              chart: snapshot.evaluation?.chart
                ? {
                    type: snapshot.evaluation.chart.type,
                    points: snapshot.evaluation.chart.points,
                    poolAddress: snapshot.evaluation.chart.poolAddress,
                    timeFrom: snapshot.evaluation.chart.timeFrom,
                    timeTo: snapshot.evaluation.chart.timeTo,
                  }
                : null,
              metrics: {
                priceUsd: snapshot.evaluation?.coin?.priceUsd ?? snapshot.evaluation?.coin?.price_usd ?? null,
                liquidityUsd: snapshot.evaluation?.pool?.liquidity_usd ?? snapshot.evaluation?.coin?.liquidityUsd ?? null,
                unrealizedUsd: snapshot.evaluation?.pnl?.unrealized_usd ?? null,
                totalUsd: snapshot.evaluation?.pnl?.total_usd ?? null,
                roiUnrealizedPct: snapshot.evaluation?.derived?.roiUnrealizedPct ?? null,
              },
              indicators: {
                rsi: indForHud.rsi ?? null,
                atr: indForHud.atr ?? null,
                emaFast: indForHud.emaFast ?? null,
                emaSlow: indForHud.emaSlow ?? null,
                macdHist: indForHud.macd?.hist ?? null,
                vwap: indForHud.vwap ?? null,
                vwapVolume: indForHud.vwapVolume ?? null,
              },
              warnings: snapshot.evaluation?.warnings || [],
            };

            emitToParent('sellOps:evaluation', hudPayload);

            // Persist every evaluation tick so we can analyze decisions over time.
            // IMPORTANT: This must never break SellOps; failures are logged and ignored.
            try {
              if (summary.walletId && summary.tradeUuid) {
                const qualifyResults = Array.isArray(snapshot.evaluation?.qualify?.results)
                  ? snapshot.evaluation.qualify.results
                  : [];

                const failedGates = qualifyResults.filter((r) => r && r.outcome === 'fail');
                // Pick the first failed gate with the same severity as worstSeverity (if possible),
                // otherwise just take the first failed gate id.
                const worstSeverity = snapshot.evaluation?.qualify?.worstSeverity || null;
                const gateFail =
                  (worstSeverity && failedGates.find((g) => g.severityOnFail === worstSeverity)?.id) ||
                  (failedGates[0] ? failedGates[0].id : null);

                BootyBox.insertSellOpsEvaluation({
                  tsMs: snapshot.ts,
                  walletId: Number(summary.walletId),
                  walletAlias: snapshot.walletAlias,
                  tradeUuid: summary.tradeUuid,
                  coinMint: summary.mint,
                  symbol: hudPayload.symbol || null,

                  strategyName: snapshot.evaluation?.strategy?.name || null,
                  strategySource: snapshot.evaluation?.strategy?.source || null,
                  recommendation: hudPayload.recommendation || 'hold',
                  decision: snapshot.decision,
                  regime: snapshot.regime?.status || null,

                  qualifyFailedCount: snapshot.evaluation?.qualify?.failedCount ?? 0,
                  qualifyWorstSeverity: worstSeverity,
                  gateFail,

                  priceUsd: hudPayload.metrics?.priceUsd ?? null,
                  liquidityUsd: hudPayload.metrics?.liquidityUsd ?? null,
                  chartInterval: hudPayload.chart?.type ?? null,
                  chartPoints: hudPayload.chart?.points ?? null,

                  rsi: hudPayload.indicators?.rsi ?? null,
                  macdHist: hudPayload.indicators?.macdHist ?? null,
                  vwap: hudPayload.indicators?.vwap ?? null,
                  warningsCount: Array.isArray(hudPayload.warnings) ? hudPayload.warnings.length : 0,

                  unrealUsd: hudPayload.metrics?.unrealizedUsd ?? null,
                  totalUsd: hudPayload.metrics?.totalUsd ?? null,
                  roiPct: hudPayload.metrics?.roiUnrealizedPct ?? null,

                  // Store the human reasons (fast to query) and a compacted full payload for future autopsy/AI.
                  reasons: snapshot.reasons,
                  payload: {
                    ...hudPayload,
                    // Keep a more complete snapshot for offline analysis without giant arrays.
                    evaluation: compactEvaluationForStorage(snapshot.evaluation),
                  },
                });
              }
            } catch (err) {
            log.warn(
              `[sellOps] persist tick failed wallet=${wallet.alias} trade_uuid=${summary.tradeUuid || 'n/a'} mint=${summary.mint || 'n/a'}: ${
                err?.message || err
              }`
            );
            }

            const tradeTag = summary.tradeUuid ? `trade_uuid=${summary.tradeUuid}` : 'trade_uuid=?';
            const mintTag = summary.mint ? `mint=${summary.mint}` : 'mint=?';

            const symbolTag = snapshot.evaluation?.symbol ? `symbol=${snapshot.evaluation.symbol}` : 'symbol=n/a';
            const tokenTag = `token=${snapshot.evaluation?.symbol || (summary.mint ? summary.mint.slice(0, 4) : 'mint')}`;

            const priceUsd = snapshot.evaluation?.coin?.priceUsd ?? snapshot.evaluation?.coin?.price_usd;
            const liqUsd = snapshot.evaluation?.pool?.liquidity_usd || snapshot.evaluation?.coin?.liquidityUsd;
            const unrealUsd = snapshot.evaluation?.pnl?.unrealized_usd;
            const totalUsd = snapshot.evaluation?.pnl?.total_usd;
            const roiPct = snapshot.evaluation?.derived?.roiUnrealizedPct;

            const chartType = snapshot.evaluation?.chart?.type;
            const chartPoints = snapshot.evaluation?.chart?.points;
            const ind = snapshot.evaluation?.indicators;
            const rsi = ind?.rsi;
            const macdHist = ind?.macd?.hist;
            const vwap = ind?.vwap;

            sellOpsLogger.info(
              `[sellOps] wallet=${wallet.alias} ${tradeTag} ${tokenTag} ${symbolTag} ${mintTag} decision=${evalResult.decision} reasons=${evalResult.reasons.join(',')} ` +
                `priceUsd=${priceUsd ?? 'n/a'} liquidityUsd=${liqUsd ?? 'n/a'} unrealUsd=${unrealUsd ?? 'n/a'} totalUsd=${totalUsd ?? 'n/a'} ` +
                `roiPct=${roiPct != null ? roiPct.toFixed(2) : 'n/a'} ` +
                `chart=${chartType && chartPoints != null ? `${chartType}:${chartPoints}` : 'n/a'} ` +
                `regime=${snapshot.regime?.status || 'n/a'} rsi=${rsi != null ? rsi.toFixed(2) : 'n/a'} ` +
                `macdHist=${macdHist != null ? Number(macdHist).toFixed(6) : 'n/a'} vwap=${vwap ?? 'n/a'} ` +
                `warnings=${(snapshot.evaluation?.warnings || []).length}`
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
              emitToParent('sellOps:autopsy', {
                ts: Date.now(),
                walletAlias: wallet.alias,
                tradeUuid,
                mint: summary.mint,
                grade: ai?.grade || null,
                summary: ai?.summary || null,
                tags: Array.isArray(ai?.tags) ? ai.tags : [],
                ai: ai || null,
                artifactPath: result?.artifactPath || null,
              });
            } catch (err) {
              const msg = err?.message || err;
            log.warn(`[sellOps] autopsy failed trade_uuid=${tradeUuid} mint=${summary.mint || 'n/a'}: ${msg}`);
            }
          }
        }
      } catch (err) {
        // Don’t crash the worker on transient errors; log + continue.
        log.error(`[sellOps] tick failed for wallet=${wallet.alias}: ${err?.message || err}`);
      }

      // Schedule next tick
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
      log.info(`[sellOps] started wallet=${wallet.alias} pollIntervalMs=${pollIntervalMs}`);
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

/**
 * Start SellOps via IPC harness.
 */
function startHarness() {
  let controller = null;

  createWorkerHarness(
    async (payload, { track, env }) => {
      // Accept either `{ wallet: { alias } }` or `{ walletAlias }` style payloads.
      const walletAlias = payload?.walletAlias || payload?.alias || payload?.wallet?.alias || payload?.wallet?.walletAlias;
      const walletPubkey = payload?.walletPubkey || payload?.pubkey || payload?.wallet?.pubkey;

      sellOpsLogger.debug(
        `[sellOps] IPC payload received keys=${Object.keys(payload || {}).join(',') || 'none'} ` +
          `walletAlias=${walletAlias || 'n/a'} walletPubkey=${walletPubkey ? String(walletPubkey).slice(0, 6) + '…' : 'n/a'}`
      );

      sellOpsLogger.debug(`[sellOps] IPC payload snapshot ${JSON.stringify(redact(payload || {}))}`);

      sellOpsLogger.debug(
        `[sellOps] env presence WARCHEST_DATA_ENDPOINT=${env?.WARCHEST_DATA_ENDPOINT ? 'yes' : 'no'} ` +
          `SOLANATRACKER_API_KEY=${env?.SOLANATRACKER_API_KEY ? 'yes' : 'no'}`
      );

      controller = createSellOpsController(
        {
          ...payload,
          wallet: payload?.wallet || { alias: walletAlias, pubkey: walletPubkey },
        },
        { track, env }
      );

      return controller.start();
    },
    {
      exitOnComplete: false, // long-lived loop
      workerName: 'sellOps',
      metricsReporter: (event) => {
        sellOpsLogger.debug?.(`[sellOps][metrics] ${JSON.stringify(event)}`);
      },
      onClose: async () => {
        if (controller && typeof controller.stop === 'function') {
          await controller.stop('terminated');
        }
      },
    }
  );

  process.on('message', (msg) => {
    if (!msg || msg.type !== 'stop') return;
    if (controller && typeof controller.stop === 'function') {
      controller.stop('stop-request');
    }
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  createSellOpsController,
  startHarness,
};
