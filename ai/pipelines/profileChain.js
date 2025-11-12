/**
 * Scoundrel Profile Chain Orchestrator
 * Stage 0 (Harvest)  → Stage 1 (Technique) → Stage 2 (Outcomes) → Stage 4 (Heuristics)
 * Persists/upserts when persistence module is available; otherwise writes dev artifacts.
 * CommonJS only.
 */

const fs = require('fs');
const path = require('path');

const { buildTechniqueFeaturesFromMintMap } = require('../../lib/analysis/techniqueOutcomes');
const { summarizeForSidecar } = require('../../lib/analysis/chartSummarizer');

// --- Hard caps (enforced in tools later; documented here for visibility) ---
const CAPS = Object.freeze({
  TOOL_MAX_CALLS_PER_RUN: 20,
  TOOL_MAX_MINTS: 8,
  TOOL_MAX_TRADES_PER_CALL: 50,
  TA_MAX_WINDOWS_PER_RUN: 4,
  TA_WINDOW_MINUTES: 15,
  TA_LOOKBACK_BARS: 120,
});

// --- Safe requires ---
let harvestMod;
try { harvestMod = require('../../lib/harvestWallet'); } catch (_) { harvestMod = null; }
let analysisMod;
try { analysisMod = require('../jobs/walletAnalysis'); } catch (_) { analysisMod = null; }
let outcomesAgent;
try { outcomesAgent = require('../agents/outcomes.agent'); } catch (_) { outcomesAgent = null; }
let heuristicsAgent;
try { heuristicsAgent = require('../agents/heuristics.agent'); } catch (_) { heuristicsAgent = null; }
let persistMod;
try { persistMod = require('../../lib/persist/profiles'); } catch (_) { persistMod = null; }

const baseLog = require('../../lib/log');
const log = {
  info:  (...a) => baseLog.info('[profileChain]', ...a),
  warn:  (...a) => baseLog.warn('[profileChain]', ...a),
  error: (...a) => baseLog.error('[profileChain]', ...a),
  debug: (...a) => baseLog.debug('[profileChain]', ...a),
};

function runId() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
const J = (o) => JSON.stringify(o, null, 2);

/**
 * Orchestrate a full profile build for a single wallet.
 * @param {Object} opts
 * @param {string} opts.wallet
 * @param {string} [opts.traderName]
 * @param {number} [opts.featureMintCount=8]
 * @param {boolean} [opts.liveTools=false]  // reserved; tools enforce caps elsewhere
 * @returns {Promise<{ technique: Object, outcomes: Object|null, heuristics: Object|null, profile: Object }>} 
 */
async function runProfileChain({ wallet, traderName, featureMintCount = 8, liveTools = false }) {
  if (!wallet) throw new Error('runProfileChain: wallet is required');
  const id = runId();
  log.info(`start wallet=${wallet} featureMintCount=${featureMintCount} liveTools=${liveTools}`);
  log.info('stage0: harvest start');

  // --- Stage 0: Harvest ---
  if (!harvestMod || !harvestMod.harvestWallet && typeof harvestMod !== 'function') {
    throw new Error('harvestwallet module not found; expected ../../lib/harvestwallet');
  }
  const harvestWallet = harvestMod.harvestWallet || harvestMod; // support default export or named

  let merged, techniqueFeatures;
  try {
    const harvestResult = await harvestWallet({ wallet, traderName, featureMintCount, runAnalysis: false });
    merged = harvestResult && (harvestResult.merged || harvestResult.mergedPayload || harvestResult.mergedJson);
    techniqueFeatures = harvestResult && (harvestResult.techniqueFeatures || harvestResult.features);
  } catch (e) {
    log.error('stage0: harvest error:', e && e.stack ? e.stack : (e?.message || e));
    throw e;
  }

  // Fallback: try to load latest on-disk merged artifact if harvest didn't return it
  if (!merged) {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (fs.existsSync(dataDir)) {
        const prefix = `${wallet}-merged-`;
        const candidates = fs.readdirSync(dataDir)
          .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
          .sort();
        if (candidates.length) {
          const last = candidates[candidates.length - 1];
          merged = JSON.parse(fs.readFileSync(path.join(dataDir, last), 'utf8'));
          log.warn('runProfileChain: merged not returned by harvest; loaded latest from disk:', last);
        }
      }
    } catch (e) {
      log.warn('runProfileChain: failed to load merged from disk fallback:', e?.message || e);
    }
  }

  if (!merged) throw new Error('runProfileChain: harvest returned no merged payload');

  // If techniqueFeatures missing, build from merged on the fly
  if (!techniqueFeatures) {
    try {
      const mintMap = merged.userTokenTradesByMint || merged.mintTradesByMint || {};
      techniqueFeatures = buildTechniqueFeaturesFromMintMap(mintMap, featureMintCount);
      log.warn('runProfileChain: techniqueFeatures missing in harvest result; computed from merged');
    } catch (e) {
      log.warn('runProfileChain: failed to compute techniqueFeatures from merged:', e?.message || e);
    }
  }

  // Dev artifact write
  const dataDir = path.join(process.cwd(), 'data');
  ensureDir(dataDir);
  try { fs.writeFileSync(path.join(dataDir, `${wallet}-chain-merged-${id}.json`), J(merged)); } catch (_) {}

  log.info('stage1: technique (LLM) start');
  // --- Stage 1: Technique (LLM via Responses) ---
  if (!analysisMod || typeof analysisMod.analyzeWallet !== 'function') {
    throw new Error('walletAnalysis job not found; expected ../jobs/walletAnalysis.analyzeWallet');
  }
  const technique = await analysisMod.analyzeWallet({ merged, purpose: 'Technique classification from features' });

  // Dev artifact write
  try { fs.writeFileSync(path.join(dataDir, `${wallet}-technique-${id}.json`), J(technique)); } catch (_) {}
  log.info('stage1: technique (LLM) done');

  log.info('stage2: outcomes (deterministic) start');
  // --- Stage 2: Outcomes (deterministic Node) ---
  let outcomes = null;
  if (outcomesAgent && typeof outcomesAgent.computeOutcomes === 'function') {
    outcomes = await outcomesAgent.computeOutcomes({ merged });
    try { fs.writeFileSync(path.join(dataDir, `${wallet}-outcomes-${id}.json`), J(outcomes)); } catch (_) {}
    log.info('stage2: outcomes (deterministic) done');
  } else {
    log.warn('Outcomes agent not available yet; skipping Stage 2');
  }

  // --- Wallet performance/curve summary (chart summarizer) ---
  // Defensive: always array or []
  const chartBlocks = summarizeForSidecar(Array.isArray(merged?.chart) ? merged.chart : []);

  log.info('stage4: heuristics (LLM) start');
  // --- Stage 4: Heuristics (tiny LLM) ---
  let heuristics = null;
  if (heuristicsAgent && typeof heuristicsAgent.inferHeuristics === 'function') {
    heuristics = await heuristicsAgent.inferHeuristics({
      technique,
      outcomes,
      wallet_performance: chartBlocks.wallet_performance,
      wallet_curve: chartBlocks.wallet_curve,
      analysisId: id,
    });
    try { fs.writeFileSync(path.join(dataDir, `${wallet}-heuristics-${id}.json`), J(heuristics)); } catch (_) {}
    log.info('stage4: heuristics (LLM) done');
  } else {
    log.warn('Heuristics agent not available yet; skipping Stage 4');
  }

  // --- Assemble final profile.machine.v1 ---
  const profile = {
    version: '1.0',
    wallet,
    traderName: traderName || null,
    generatedAt: new Date().toISOString(),
    technique: technique || null,
    outcomes: outcomes || null,
    heuristics: heuristics || null,
    enrichment: null,
    caps: CAPS,
    wallet_performance: chartBlocks.wallet_performance,
    wallet_curve: chartBlocks.wallet_curve,
  };

  // Write human/machine artifacts under profiles/
  const profilesDir = path.join(process.cwd(), 'profiles');
  ensureDir(profilesDir);
  ensureDir(path.join(profilesDir, '.machine'));
  try { fs.writeFileSync(path.join(profilesDir, `${wallet}.json`), J({ wallet, traderName: traderName || null, summary: summarizeProfile(profile) })); } catch (_) {}
  let nextVersion = '0-dev';
  try {
    nextVersion = await safeVersionFor(wallet);
    fs.writeFileSync(path.join(profilesDir, `.machine/${wallet}-v${nextVersion}.json`), J(profile));
  } catch (_) {}
  // Write sidecar JSON with chart summary and meta
  try {
    const sidecar = {
      meta: {
        wallet,
        traderName: traderName || null,
        runId: id,
        featureMintCount,
      },
      wallet_performance: chartBlocks.wallet_performance,
      wallet_curve: chartBlocks.wallet_curve,
      aggregates: outcomes || null,
    };
    fs.writeFileSync(
      path.join(profilesDir, `.machine/${wallet}-v${nextVersion}.sidecar.json`),
      J(sidecar)
    );
  } catch (_) {}

  // --- Persist to DB if module exists ---
  if (persistMod && typeof persistMod.persistProfileArtifacts === 'function') {
    await persistMod.persistProfileArtifacts({ wallet, technique, outcomes, heuristics, enrichment: null });
  } else {
    log.warn('Persistence module not available; skipping DB upsert (will add in Phase 2)');
  }

  log.info('done', { wallet, technique: !!technique, outcomes: !!outcomes, heuristics: !!heuristics });
  return { technique, outcomes, heuristics, profile, summary: summarizeProfile(profile) };
}

async function safeVersionFor(wallet) {
  try {
    const { getLatestVersion } = require('../../lib/persist/profiles');
    const v = await getLatestVersion(wallet);
    return Number.isFinite(v) ? v + 1 : '0-dev';
  } catch (_) {
    return '0-dev';
  }
}

function summarizeProfile(p) {
  const t = p.technique || {};
  const o = p.outcomes || {};
  return {
    style: t.style || 'unknown',
    entryTechnique: t.entryTechnique || 'unknown',
    avgExitGainPct: t.avgExitGainPct ?? null,
    winRate: o.winRate ?? null,
    medianExitPct: o.medianExitPct ?? null,
    medianHoldMins: o.medianHoldMins ?? null,
    notes: (t.comment ? [t.comment] : []).slice(0,1),
  };
}

module.exports = { runProfileChain, CAPS };