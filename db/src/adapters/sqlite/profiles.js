'use strict';

const { db, logger } = require('./context');
const { ensureKolWalletForProfile } = require('./wallets');

function upsertProfileSnapshot({ profileId, name, wallet, profile, source }) {
  if (!profileId || !wallet) {
    throw new Error('upsertProfileSnapshot: profileId and wallet required');
  }
  const serialized = typeof profile === 'string' ? profile : JSON.stringify(profile || null);

  db.prepare(
    `INSERT INTO sc_profiles (
       profile_id, name, wallet, profile, source, created_at, updated_at
     ) VALUES (
       @profile_id, @name, @wallet, @profile, @source, @created_at, @updated_at
     )
     ON CONFLICT(profile_id) DO UPDATE SET
       name = excluded.name,
       wallet = excluded.wallet,
       profile = excluded.profile,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run({
    profile_id: profileId,
    name: name || wallet,
    wallet,
    profile: serialized,
    source: source || null,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

function recordWalletAnalysis({
  analysisId,
  wallet,
  traderName,
  tradeCount,
  chartCount,
  merged,
  responseRaw,
  jsonVersion,
}) {
  if (!analysisId || !wallet) {
    throw new Error('recordWalletAnalysis: analysisId and wallet required');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_wallet_analyses (
       analysis_id,
       wallet,
       trader_name,
       trade_count,
       chart_count,
       json_version,
       merged,
       response_raw,
       created_at,
       updated_at
     ) VALUES (
       @analysis_id,
       @wallet,
       @trader_name,
       @trade_count,
       @chart_count,
       @json_version,
       @merged,
       @response_raw,
       @created_at,
       @updated_at
     )
     ON CONFLICT(analysis_id) DO UPDATE SET
       trader_name = excluded.trader_name,
       trade_count = excluded.trade_count,
       chart_count = excluded.chart_count,
       json_version = excluded.json_version,
       merged = excluded.merged,
       response_raw = excluded.response_raw,
       updated_at = excluded.updated_at`
  ).run({
    analysis_id: analysisId,
    wallet,
    trader_name: traderName || null,
    trade_count: Number.isFinite(tradeCount) ? tradeCount : 0,
    chart_count: Number.isFinite(chartCount) ? chartCount : 0,
    json_version: jsonVersion || null,
    merged: JSON.stringify(merged ?? null),
    response_raw: JSON.stringify(responseRaw ?? null),
    created_at: now,
    updated_at: now,
  });

  try {
    ensureKolWalletForProfile(wallet, traderName);
  } catch (err) {
    logger.warn(`[BootyBox] Failed to sync KOL wallet for ${wallet}: ${err.message}`);
  }
}

function getWalletAnalysisById(analysisId) {
  if (!analysisId) return null;
  return db.prepare('SELECT * FROM sc_wallet_analyses WHERE analysis_id = ?').get(analysisId);
}

function listWalletAnalysesByWallet(wallet, { limit = 20 } = {}) {
  if (!wallet) return [];
  const safeLimit = Number.isFinite(limit) ? limit : 20;
  return db
    .prepare(
      `SELECT * FROM sc_wallet_analyses
       WHERE wallet = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(wallet, safeLimit);
}

function recordTradeAutopsy({ autopsyId, wallet, mint, symbol, payload, responseRaw, jsonVersion }) {
  if (!autopsyId || !wallet || !mint) {
    throw new Error('recordTradeAutopsy: autopsyId, wallet, and mint required');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_trade_autopsies (
       autopsy_id,
       wallet,
       mint,
       symbol,
       json_version,
       payload,
       response_raw,
       created_at,
       updated_at
     ) VALUES (
       @autopsy_id,
       @wallet,
       @mint,
       @symbol,
       @json_version,
       @payload,
       @response_raw,
       @created_at,
       @updated_at
     )
     ON CONFLICT(autopsy_id) DO UPDATE SET
       wallet = excluded.wallet,
       mint = excluded.mint,
       symbol = excluded.symbol,
       json_version = excluded.json_version,
       payload = excluded.payload,
       response_raw = excluded.response_raw,
       updated_at = excluded.updated_at`
  ).run({
    autopsy_id: autopsyId,
    wallet,
    mint,
    symbol: symbol || null,
    json_version: jsonVersion || null,
    payload: JSON.stringify(payload ?? null),
    response_raw: JSON.stringify(responseRaw ?? null),
    created_at: now,
    updated_at: now,
  });
}

function getTradeAutopsyById(autopsyId) {
  if (!autopsyId) return null;
  return db.prepare('SELECT * FROM sc_trade_autopsies WHERE autopsy_id = ?').get(autopsyId);
}

function listTradeAutopsiesByWallet(wallet, { limit = 20 } = {}) {
  if (!wallet) return [];
  const safeLimit = Number.isFinite(limit) ? limit : 20;
  return db
    .prepare(
      `SELECT * FROM sc_trade_autopsies
       WHERE wallet = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(wallet, safeLimit);
}

function recordAsk({
  askId,
  correlationId,
  question,
  profile,
  rows,
  model,
  temperature,
  responseRaw,
  answer,
  bullets,
  actions,
}) {
  if (!askId || !question) {
    throw new Error('recordAsk: askId and question are required');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_asks (
       ask_id,
       correlation_id,
       question,
       profile,
       rows,
       model,
       temperature,
       response_raw,
       answer,
       bullets,
       actions,
       created_at
     ) VALUES (
       @ask_id,
       @correlation_id,
       @question,
       @profile,
       @rows,
       @model,
       @temperature,
       @response_raw,
       @answer,
       @bullets,
       @actions,
       @created_at
     )`
  ).run({
    ask_id: askId,
    correlation_id: correlationId || askId,
    question,
    profile: profile ? JSON.stringify(profile) : null,
    rows: rows ? JSON.stringify(rows) : null,
    model: model || null,
    temperature: typeof temperature === 'number' ? temperature : null,
    response_raw: JSON.stringify(responseRaw ?? null),
    answer: answer || '',
    bullets: JSON.stringify(Array.isArray(bullets) ? bullets : []),
    actions: JSON.stringify(Array.isArray(actions) ? actions : []),
    created_at: now,
  });
}

function recordTune({
  tuneId,
  correlationId,
  profile,
  currentSettings,
  model,
  temperature,
  responseRaw,
  answer,
  bullets,
  actions,
  changes,
  patch,
  risks,
  rationale,
}) {
  if (!tuneId) {
    throw new Error('recordTune: tuneId is required');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_tunes (
       tune_id,
       correlation_id,
       profile,
       current_settings,
       model,
       temperature,
       response_raw,
       answer,
       bullets,
       actions,
       changes,
       patch,
       risks,
       rationale,
       created_at
     ) VALUES (
       @tune_id,
       @correlation_id,
       @profile,
       @current_settings,
       @model,
       @temperature,
       @response_raw,
       @answer,
       @bullets,
       @actions,
       @changes,
       @patch,
       @risks,
       @rationale,
       @created_at
     )`
  ).run({
    tune_id: tuneId,
    correlation_id: correlationId || tuneId,
    profile: profile ? JSON.stringify(profile) : null,
    current_settings: currentSettings ? JSON.stringify(currentSettings) : null,
    model: model || null,
    temperature: typeof temperature === 'number' ? temperature : null,
    response_raw: JSON.stringify(responseRaw ?? null),
    answer: answer || '',
    bullets: JSON.stringify(Array.isArray(bullets) ? bullets : []),
    actions: JSON.stringify(Array.isArray(actions) ? actions : []),
    changes: JSON.stringify(changes && typeof changes === 'object' ? changes : {}),
    patch: JSON.stringify(Array.isArray(patch) ? patch : []),
    risks: JSON.stringify(Array.isArray(risks) ? risks : []),
    rationale: typeof rationale === 'string' ? rationale : '',
    created_at: now,
  });
}

function recordJobRun({ jobRunId, job, context, input, responseRaw }) {
  if (!jobRunId || !job) {
    throw new Error('recordJobRun: jobRunId and job are required');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_job_runs (
       job_run_id,
       job,
       context,
       input,
       response_raw,
       created_at
     ) VALUES (
       @job_run_id,
       @job,
       @context,
       @input,
       @response_raw,
       @created_at
     )`
  ).run({
    job_run_id: jobRunId,
    job,
    context: context != null ? JSON.stringify(context) : null,
    input: JSON.stringify(input ?? null),
    response_raw: JSON.stringify(responseRaw ?? null),
    created_at: now,
  });
}

const profileJson = (value) => (value == null ? null : JSON.stringify(value));

function sqlNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function getLatestWalletProfileVersion(wallet) {
  if (!wallet) return 0;
  const row = db.prepare('SELECT version FROM sc_wallet_profiles WHERE wallet = ? LIMIT 1').get(wallet);
  if (!row || row.version == null) return 0;
  const raw = Number(row.version);
  return Number.isFinite(raw) ? raw : 0;
}

function persistWalletProfileArtifacts({ wallet, technique, outcomes, heuristics, enrichment }) {
  if (!wallet) {
    throw new Error('persistWalletProfileArtifacts: wallet is required');
  }
  const updatedAt = sqlNow();
  const version = getLatestWalletProfileVersion(wallet) + 1;

  const techniqueJson = profileJson(technique);
  const outcomesJson = profileJson(outcomes);
  const heuristicsJson = profileJson(heuristics);
  const enrichmentJson = profileJson(enrichment);

  db.prepare(
    `INSERT INTO sc_wallet_profiles
       (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET
       version = excluded.version,
       technique_json = excluded.technique_json,
       outcomes_json = excluded.outcomes_json,
       heuristics_json = excluded.heuristics_json,
       enrichment_json = excluded.enrichment_json,
       updated_at = excluded.updated_at`
  ).run(wallet, version, techniqueJson, outcomesJson, heuristicsJson, enrichmentJson, updatedAt);

  db.prepare(
    `INSERT INTO sc_wallet_profile_versions
       (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(wallet, version, techniqueJson, outcomesJson, heuristicsJson, enrichmentJson, updatedAt);

  db.prepare(
    `INSERT INTO sc_wallet_profile_index
       (wallet, style, entry_technique, win_rate, median_exit_pct, median_hold_mins, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET
       style = excluded.style,
       entry_technique = excluded.entry_technique,
       win_rate = excluded.win_rate,
       median_exit_pct = excluded.median_exit_pct,
       median_hold_mins = excluded.median_hold_mins,
       last_seen_at = excluded.last_seen_at`
  ).run(
    wallet,
    (technique && technique.style) || null,
    (technique && technique.entryTechnique) || null,
    (outcomes && outcomes.winRate) ?? null,
    (outcomes && outcomes.medianExitPct) ?? null,
    (outcomes && outcomes.medianHoldMins) ?? null,
    updatedAt
  );
}

module.exports = {
  getLatestWalletProfileVersion,
  getTradeAutopsyById,
  getWalletAnalysisById,
  listTradeAutopsiesByWallet,
  listWalletAnalysesByWallet,
  persistWalletProfileArtifacts,
  recordAsk,
  recordJobRun,
  recordTradeAutopsy,
  recordTune,
  recordWalletAnalysis,
  upsertProfileSnapshot,
};
