const {
  db,
  logger,
  chalk,
  pendingSwaps,
  tradeUuidMap,
  saveInput,
  normalizeWalletField,
  setTradeUuid,
  getTradeUuid,
  clearTradeUuid,
  resolveTradeUuid,
  upsertPendingTradeUuid,
  deletePendingTradeUuid,
  setDefaultWalletPublicKey,
  getDefaultWalletPublicKey,
} = require('./context');
let dbClosed = false;
let defaultWalletPublicKey = getDefaultWalletPublicKey();

function toFiniteOrNull(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// ==== Scoundrel/wallet-profile helpers ====
function mapWalletRow(row) {
  if (!row) return null;
  return {
    walletId: row.walletId,
    alias: row.alias,
    pubkey: row.pubkey,
    usageType: row.usageType,
    isDefaultFunding: !!row.isDefaultFunding,
    autoAttachWarchest: !!row.autoAttachWarchest,
    strategyId: row.strategyId,
    color: row.color,
    hasPrivateKey: !!row.hasPrivateKey,
    keySource: row.keySource,
    keyRef: row.keyRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ensureKolWalletForProfile(wallet, traderName) {
  const pubkey = normalizeWalletField(wallet);
  if (!pubkey) return;

  const aliasFromName =
    traderName && typeof traderName === "string"
      ? traderName.trim()
      : null;
  const alias = (aliasFromName && aliasFromName.slice(0, 64)) || pubkey;

  const existing = db
    .prepare(
      "SELECT wallet_id, alias, usage_type FROM sc_wallets WHERE pubkey = ? LIMIT 1"
    )
    .get(pubkey);

  if (existing) {
    const updates = [];
    const params = [];

    if (
      aliasFromName &&
      (!existing.alias || existing.alias === existing.pubkey)
    ) {
      updates.push("alias = ?");
      params.push(aliasFromName.slice(0, 64));
    }

    if (!existing.usage_type || existing.usage_type === "other") {
      updates.push("usage_type = 'kol'");
    }

    if (!updates.length) return;

    params.push(Date.now(), existing.wallet_id);
    db.prepare(
      `UPDATE sc_wallets SET ${updates.join(", ")}, updated_at = ? WHERE wallet_id = ?`
    ).run(...params);
    return;
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_wallets (
       alias,
       pubkey,
       usage_type,
       is_default_funding,
       auto_attach_warchest,
       strategy_id,
       color,
       has_private_key,
       key_source,
       key_ref,
       created_at,
       updated_at
     ) VALUES (
       @alias,
       @pubkey,
       @usage_type,
       @is_default_funding,
       @auto_attach_warchest,
       @strategy_id,
       @color,
       @has_private_key,
       @key_source,
       @key_ref,
       @created_at,
       @updated_at
     )`
  ).run({
    alias,
    pubkey,
    usage_type: "kol",
    is_default_funding: 0,
    auto_attach_warchest: 0,
    strategy_id: null,
    color: null,
    has_private_key: 0,
    key_source: "none",
    key_ref: null,
    created_at: now,
    updated_at: now,
  });
}

function listWarchestWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function listWalletsByUsage(usageType) {
  let sql = `
    SELECT
      wallet_id            AS walletId,
      alias,
      pubkey,
      usage_type           AS usageType,
      is_default_funding   AS isDefaultFunding,
      auto_attach_warchest AS autoAttachWarchest,
      strategy_id          AS strategyId,
      color,
      has_private_key      AS hasPrivateKey,
      key_source           AS keySource,
      key_ref              AS keyRef,
      created_at           AS createdAt,
      updated_at           AS updatedAt
    FROM sc_wallets
  `;
  const params = [];

  if (usageType) {
    sql += " WHERE usage_type = ?";
    params.push(usageType);
  }

  sql += " ORDER BY alias ASC";

  const rows = db.prepare(sql).all(...params);
  return (rows || []).map(mapWalletRow);
}

function listAutoAttachedWarchestWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE auto_attach_warchest = 1
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function getWarchestWalletByAlias(alias) {
  if (!alias) return null;
  const row = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE alias = ?
       LIMIT 1`
    )
    .get(alias);
  return row ? mapWalletRow(row) : null;
}

function insertWarchestWallet(record) {
  if (!record || !record.alias || !record.pubkey) {
    throw new Error("insertWarchestWallet: alias and pubkey are required fields.");
  }
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO sc_wallets (
       alias,
       pubkey,
       usage_type,
       is_default_funding,
       auto_attach_warchest,
       strategy_id,
       color,
       has_private_key,
       key_source,
       key_ref,
       created_at,
       updated_at
     ) VALUES (
       @alias,
       @pubkey,
       @usage_type,
       @is_default_funding,
       @auto_attach_warchest,
       @strategy_id,
       @color,
       @has_private_key,
       @key_source,
       @key_ref,
       @created_at,
       @updated_at
     )`
  );
  stmt.run({
    alias: record.alias,
    pubkey: record.pubkey,
    usage_type: record.usageType || "other",
    is_default_funding: record.isDefaultFunding ? 1 : 0,
    auto_attach_warchest: record.autoAttachWarchest ? 1 : 0,
    strategy_id: record.strategyId ?? null,
    color: record.color ?? null,
    has_private_key: record.hasPrivateKey ? 1 : 0,
    key_source: record.keySource || "none",
    key_ref: record.keyRef ?? null,
    created_at: now,
    updated_at: now,
  });
  return getWarchestWalletByAlias(record.alias);
}

function updateWarchestWalletColor(alias, color) {
  if (!alias) return false;
  const res = db
    .prepare("UPDATE sc_wallets SET color = ?, updated_at = ? WHERE alias = ?")
    .run(color, Date.now(), alias);
  return !!(res && res.changes);
}

function deleteWarchestWallet(alias) {
  if (!alias) return false;
  const res = db
    .prepare("DELETE FROM sc_wallets WHERE alias = ?")
    .run(alias);
  return !!(res && res.changes);
}

function listFundingWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE usage_type = 'funding'
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function getDefaultFundingWallet() {
  const row = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE is_default_funding = 1
       LIMIT 1`
    )
    .get();
  return row ? mapWalletRow(row) : null;
}

function setDefaultFundingWallet(identifier) {
  if (!identifier) return null;

  const walletRow = db
    .prepare(
      `SELECT wallet_id, alias, pubkey
       FROM sc_wallets
       WHERE alias = ? OR pubkey = ?
       LIMIT 1`
    )
    .get(identifier, identifier);

  if (!walletRow) {
    return null;
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE sc_wallets SET is_default_funding = 0"
    ).run();
    db.prepare(
      "UPDATE sc_wallets SET is_default_funding = 1, updated_at = ? WHERE wallet_id = ?"
    ).run(now, walletRow.wallet_id);
  });

  tx();
  return getWarchestWalletByAlias(walletRow.alias);
}

function listTrackedKolWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE usage_type = 'kol'
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function upsertKolWalletFromDossier({ wallet, traderName, color }) {
  if (!wallet) {
    throw new Error("upsertKolWalletFromDossier: wallet is required");
  }
  const now = Date.now();

  const existing = db
    .prepare(
      "SELECT wallet_id, alias, pubkey, color FROM sc_wallets WHERE pubkey = ? LIMIT 1"
    )
    .get(wallet);

  const safeAliasFromWallet = () => {
    const str = String(wallet);
    if (str.length <= 8) return str;
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
  };

  const alias =
    (traderName && String(traderName).trim()) || safeAliasFromWallet();

  if (!existing) {
    db.prepare(
      `INSERT INTO sc_wallets (
         alias,
         pubkey,
         usage_type,
         is_default_funding,
         auto_attach_warchest,
         strategy_id,
         color,
         has_private_key,
         key_source,
         key_ref,
         created_at,
         updated_at
       ) VALUES (
         @alias,
         @pubkey,
         @usage_type,
         @is_default_funding,
         @auto_attach_warchest,
         @strategy_id,
         @color,
         @has_private_key,
         @key_source,
         @key_ref,
         @created_at,
         @updated_at
       )`
    ).run({
      alias,
      pubkey: wallet,
      usage_type: "kol",
      is_default_funding: 0,
      auto_attach_warchest: 0,
      strategy_id: null,
      color: color ?? null,
      has_private_key: 0,
      key_source: "none",
      key_ref: null,
      created_at: now,
      updated_at: now,
    });
  } else {
    db.prepare(
      `UPDATE sc_wallets
       SET alias = @alias,
           usage_type = 'kol',
           color = @color,
           updated_at = @updated_at
       WHERE wallet_id = @wallet_id`
    ).run({
      wallet_id: existing.wallet_id,
      alias,
      color: color ?? existing.color ?? null,
      updated_at: now,
    });
  }

  return getWarchestWalletByAlias(alias);
}

function upsertProfileSnapshot({
  profileId,
  name,
  wallet,
  profile,
  source,
}) {
  if (!profileId || !wallet) {
    throw new Error("upsertProfileSnapshot: profileId and wallet required");
  }
  const serialized =
    typeof profile === "string" ? profile : JSON.stringify(profile || null);

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
    throw new Error("recordWalletAnalysis: analysisId and wallet required");
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
    logger.warn(
      `[BootyBox] Failed to sync KOL wallet for ${wallet}: ${err.message}`
    );
  }
}

function getWalletAnalysisById(analysisId) {
  if (!analysisId) return null;
  return db
    .prepare("SELECT * FROM sc_wallet_analyses WHERE analysis_id = ?")
    .get(analysisId);
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

function recordTradeAutopsy({
  autopsyId,
  wallet,
  mint,
  symbol,
  payload,
  responseRaw,
  jsonVersion,
}) {
  if (!autopsyId || !wallet || !mint) {
    throw new Error("recordTradeAutopsy: autopsyId, wallet, and mint required");
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
  return db
    .prepare("SELECT * FROM sc_trade_autopsies WHERE autopsy_id = ?")
    .get(autopsyId);
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
    throw new Error("recordAsk: askId and question are required");
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
    temperature:
      typeof temperature === "number" ? temperature : null,
    response_raw: JSON.stringify(responseRaw ?? null),
    answer: answer || "",
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
    throw new Error("recordTune: tuneId is required");
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
    current_settings: currentSettings
      ? JSON.stringify(currentSettings)
      : null,
    model: model || null,
    temperature:
      typeof temperature === "number" ? temperature : null,
    response_raw: JSON.stringify(responseRaw ?? null),
    answer: answer || "",
    bullets: JSON.stringify(Array.isArray(bullets) ? bullets : []),
    actions: JSON.stringify(Array.isArray(actions) ? actions : []),
    changes:
      JSON.stringify(
        changes && typeof changes === "object" ? changes : {}
      ),
    patch: JSON.stringify(Array.isArray(patch) ? patch : []),
    risks: JSON.stringify(Array.isArray(risks) ? risks : []),
    rationale: typeof rationale === "string" ? rationale : "",
    created_at: now,
  });
}

function recordJobRun({
  jobRunId,
  job,
  context,
  input,
  responseRaw,
}) {
  if (!jobRunId || !job) {
    throw new Error("recordJobRun: jobRunId and job are required");
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

const profileJson = (value) =>
  value == null ? null : JSON.stringify(value);

function sqlNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
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
  const row = db
    .prepare(
      "SELECT version FROM sc_wallet_profiles WHERE wallet = ? LIMIT 1"
    )
    .get(wallet);
  if (!row || row.version == null) return 0;
  const raw = Number(row.version);
  return Number.isFinite(raw) ? raw : 0;
}

function persistWalletProfileArtifacts({
  wallet,
  technique,
  outcomes,
  heuristics,
  enrichment,
}) {
  if (!wallet) {
    throw new Error("persistWalletProfileArtifacts: wallet is required");
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
  ).run(
    wallet,
    version,
    techniqueJson,
    outcomesJson,
    heuristicsJson,
    enrichmentJson,
    updatedAt
  );

  db.prepare(
    `INSERT INTO sc_wallet_profile_versions
       (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    wallet,
    version,
    techniqueJson,
    outcomesJson,
    heuristicsJson,
    enrichmentJson,
    updatedAt
  );

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

function recordScTradeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("recordScTradeEvent: event object is required");
  }

  const txid = String(event.txid || event.txId || event.signature || "").trim();
  if (!txid) {
    throw new Error("recordScTradeEvent: txid is required");
  }

  const walletId = event.walletId;
  const walletAlias = event.walletAlias || null;
  const coinMint = event.coinMint || event.mint || null;
  const side = event.side === "sell" ? "sell" : "buy";

  if (walletId == null) {
    throw new Error("recordScTradeEvent: walletId is required");
  }
  if (!coinMint) {
    throw new Error("recordScTradeEvent: coinMint is required");
  }

  const executedAt = Number.isFinite(Number(event.executedAt))
    ? Number(event.executedAt)
    : Date.now();

  const tokenAmount = Number.isFinite(Number(event.tokenAmount))
    ? Number(event.tokenAmount)
    : 0;
  const solAmount = Number.isFinite(Number(event.solAmount))
    ? Number(event.solAmount)
    : 0;

  const tradeUuid = event.tradeUuid || null;
  const strategyId = event.strategyId || null;
  const strategyName = event.strategyName || null;

  const priceSolPerToken = toFiniteOrNull(event.priceSolPerToken);
  const priceUsdPerToken = toFiniteOrNull(event.priceUsdPerToken);
  const solUsdPrice = toFiniteOrNull(event.solUsdPrice);

  const feesSol = toFiniteOrNull(event.feesSol);
  const feesUsd = toFiniteOrNull(event.feesUsd);

  const slippagePct = toFiniteOrNull(event.slippagePct);
  const priceImpactPct = toFiniteOrNull(event.priceImpactPct);

  const program = event.program || null;

  const evaluationPayload =
    event.evaluationPayload != null
      ? JSON.stringify(event.evaluationPayload)
      : null;
  const decisionPayload =
    event.decisionPayload != null
      ? JSON.stringify(event.decisionPayload)
      : null;
  const decisionLabel = event.decisionLabel || null;
  const decisionReason = event.decisionReason || null;

  const now = Date.now();

  db.prepare(
    `INSERT INTO sc_trades (
       txid,
       wallet_id,
       wallet_alias,
       coin_mint,
       side,
       executed_at,
       token_amount,
       sol_amount,
       trade_uuid,
       strategy_id,
       strategy_name,
       price_sol_per_token,
       price_usd_per_token,
       sol_usd_price,
       fees_sol,
       fees_usd,
       slippage_pct,
       price_impact_pct,
       program,
       evaluation_payload,
       decision_payload,
       decision_label,
       decision_reason,
       created_at,
       updated_at
     ) VALUES (
       @txid,
       @wallet_id,
       @wallet_alias,
       @coin_mint,
       @side,
       @executed_at,
       @token_amount,
       @sol_amount,
       @trade_uuid,
       @strategy_id,
       @strategy_name,
       @price_sol_per_token,
       @price_usd_per_token,
       @sol_usd_price,
       @fees_sol,
       @fees_usd,
       @slippage_pct,
       @price_impact_pct,
       @program,
       @evaluation_payload,
       @decision_payload,
       @decision_label,
       @decision_reason,
       @created_at,
       @updated_at
     )
     ON CONFLICT(txid) DO UPDATE SET
       wallet_id = excluded.wallet_id,
       wallet_alias = COALESCE(excluded.wallet_alias, wallet_alias),
       coin_mint = excluded.coin_mint,
       side = excluded.side,
       executed_at = excluded.executed_at,
       token_amount = excluded.token_amount,
       sol_amount = excluded.sol_amount,
       trade_uuid = COALESCE(excluded.trade_uuid, trade_uuid),
       strategy_id = COALESCE(excluded.strategy_id, strategy_id),
       strategy_name = COALESCE(excluded.strategy_name, strategy_name),
       price_sol_per_token = CASE
         WHEN excluded.price_sol_per_token IS NULL THEN price_sol_per_token
         ELSE excluded.price_sol_per_token
       END,
       price_usd_per_token = CASE
         WHEN excluded.price_usd_per_token IS NULL THEN price_usd_per_token
         ELSE excluded.price_usd_per_token
       END,
       sol_usd_price = CASE
         WHEN excluded.sol_usd_price IS NULL THEN sol_usd_price
         ELSE excluded.sol_usd_price
       END,
       fees_sol = CASE
         WHEN excluded.fees_sol IS NULL THEN fees_sol
         ELSE excluded.fees_sol
       END,
       fees_usd = CASE
         WHEN excluded.fees_usd IS NULL THEN fees_usd
         ELSE excluded.fees_usd
       END,
       slippage_pct = COALESCE(excluded.slippage_pct, slippage_pct),
       price_impact_pct = COALESCE(excluded.price_impact_pct, price_impact_pct),
       program = COALESCE(excluded.program, program),
       evaluation_payload = COALESCE(excluded.evaluation_payload, evaluation_payload),
       decision_payload = COALESCE(excluded.decision_payload, decision_payload),
       decision_label = COALESCE(excluded.decision_label, decision_label),
       decision_reason = COALESCE(excluded.decision_reason, decision_reason),
       updated_at = excluded.updated_at`
  ).run({
    txid,
    wallet_id: walletId,
    wallet_alias: walletAlias,
    coin_mint: coinMint,
    side,
    executed_at: executedAt,
    token_amount: tokenAmount,
    sol_amount: solAmount,
    trade_uuid: tradeUuid,
    strategy_id: strategyId,
    strategy_name: strategyName,
    price_sol_per_token: priceSolPerToken,
    price_usd_per_token: priceUsdPerToken,
    sol_usd_price: solUsdPrice,
    fees_sol: feesSol,
    fees_usd: feesUsd,
    slippage_pct: slippagePct,
    price_impact_pct: priceImpactPct,
    program,
    evaluation_payload: evaluationPayload,
    decision_payload: decisionPayload,
    decision_label: decisionLabel,
    decision_reason: decisionReason,
    created_at: now,
    updated_at: now,
  });
}

function derivePriceSolPerToken(event, tokenAmount) {
  const explicit = Number.isFinite(Number(event.priceSolPerToken))
    ? Number(event.priceSolPerToken)
    : null;
  if (explicit && explicit > 0) return explicit;
  const solAmount = Number.isFinite(Number(event.solAmount))
    ? Math.abs(Number(event.solAmount))
    : null;
  if (solAmount != null && tokenAmount > 0) {
    return solAmount / tokenAmount;
  }
  return null;
}

function derivePriceUsdPerToken(event, priceSolPerToken) {
  const explicit = Number.isFinite(Number(event.priceUsdPerToken))
    ? Number(event.priceUsdPerToken)
    : null;
  if (explicit && explicit > 0) return explicit;
  const solUsdPrice = Number.isFinite(Number(event.solUsdPrice))
    ? Number(event.solUsdPrice)
    : null;
  if (solUsdPrice != null && priceSolPerToken != null && priceSolPerToken > 0) {
    return solUsdPrice * priceSolPerToken;
  }
  return null;
}

function applyScTradeEventToPositions(event) {
  if (!event || typeof event !== "object") {
    throw new Error("applyScTradeEventToPositions: event object is required");
  }

  const walletId = event.walletId;
  const walletAlias = event.walletAlias || null;
  const coinMint = event.coinMint || event.mint || null;
  const tradeUuid = event.tradeUuid || null;
  const side = event.side === "sell" ? "sell" : "buy";

  if (walletId == null) {
    throw new Error("applyScTradeEventToPositions: walletId is required");
  }
  if (!coinMint) {
    throw new Error("applyScTradeEventToPositions: coinMint is required");
  }

  const executedAt = Number.isFinite(Number(event.executedAt))
    ? Number(event.executedAt)
    : Date.now();

  const tokenAmount = Number.isFinite(Number(event.tokenAmount))
    ? Number(event.tokenAmount)
    : 0;

  if (tokenAmount <= 0) {
    // Nothing to do for zero-amount events.
    return;
  }

  const now = Date.now();
  const priceSolPerToken = derivePriceSolPerToken(event, tokenAmount);
  const priceUsdPerToken = derivePriceUsdPerToken(event, priceSolPerToken);

  // Select existing position for this wallet/mint (and trade_uuid if provided).
  let selectSql =
    "SELECT * FROM sc_positions WHERE wallet_id = ? AND coin_mint = ?";
  const params = [walletId, coinMint];

  if (tradeUuid) {
    selectSql += " AND trade_uuid = ?";
    params.push(tradeUuid);
  }

  selectSql += " LIMIT 1";

  const existing = db.prepare(selectSql).get(...params);

  if (!existing && side === "sell") {
    // Selling a position we do not have a row for yet. For now log and bail.
    logger.warn(
      `[BootyBox] applyScTradeEventToPositions: SELL for mint ${coinMint} on wallet ${walletId} without existing sc_position; ignoring.`
    );
    return;
  }

  if (!existing && side === "buy") {
    const currentTokenAmount = tokenAmount;
    const totalTokensBought = tokenAmount;
    const totalTokensSold = 0;

    db.prepare(
      `INSERT INTO sc_positions (
         wallet_id,
         wallet_alias,
         coin_mint,
         trade_uuid,
         open_at,
         closed_at,
         last_trade_at,
         last_updated_at,
         entry_token_amount,
         current_token_amount,
         total_tokens_bought,
         total_tokens_sold,
         strategy_id,
         strategy_name,
         entry_price_sol,
         entry_price_usd,
         last_price_sol,
         last_price_usd
       ) VALUES (
         @wallet_id,
         @wallet_alias,
         @coin_mint,
         @trade_uuid,
         @open_at,
         @closed_at,
         @last_trade_at,
         @last_updated_at,
         @entry_token_amount,
         @current_token_amount,
         @total_tokens_bought,
         @total_tokens_sold,
         @strategy_id,
         @strategy_name,
         @entry_price_sol,
         @entry_price_usd,
         @last_price_sol,
         @last_price_usd
       )`
    ).run({
      wallet_id: walletId,
      wallet_alias: walletAlias,
      coin_mint: coinMint,
      trade_uuid: tradeUuid,
      open_at: executedAt,
      closed_at: null,
      last_trade_at: executedAt,
      last_updated_at: now,
      entry_token_amount: currentTokenAmount,
      current_token_amount: currentTokenAmount,
      total_tokens_bought: totalTokensBought,
      total_tokens_sold: totalTokensSold,
      strategy_id: event.strategyId || null,
      strategy_name: event.strategyName || null,
      entry_price_sol: priceSolPerToken,
      entry_price_usd: priceUsdPerToken,
      last_price_sol: priceSolPerToken,
      last_price_usd: priceUsdPerToken,
    });
    return;
  }

  // Update existing position.
  const currentTokenAmount = Number(existing.current_token_amount || 0);
  const totalTokensBought = Number(existing.total_tokens_bought || 0);
  const totalTokensSold = Number(existing.total_tokens_sold || 0);

  let nextCurrent = currentTokenAmount;
  let nextBought = totalTokensBought;
  let nextSold = totalTokensSold;

  if (side === "buy") {
    nextCurrent = currentTokenAmount + tokenAmount;
    nextBought = totalTokensBought + tokenAmount;
  } else {
    nextCurrent = currentTokenAmount - tokenAmount;
    nextSold = totalTokensSold + tokenAmount;
  }

  const closedAt = nextCurrent <= 0 ? executedAt : existing.closed_at || null;

  const entryTokenFallback =
    Number(existing.entry_token_amount) > 0 ? existing.entry_token_amount : nextBought;
  const entryPriceSolFallback =
    Number(existing.entry_price_sol) > 0 ? existing.entry_price_sol : priceSolPerToken;
  const entryPriceUsdFallback =
    Number(existing.entry_price_usd) > 0 ? existing.entry_price_usd : priceUsdPerToken;

  db.prepare(
    `UPDATE sc_positions SET
       wallet_alias = COALESCE(@wallet_alias, wallet_alias),
       trade_uuid = COALESCE(@trade_uuid, trade_uuid),
       last_trade_at = @last_trade_at,
       last_updated_at = @last_updated_at,
       current_token_amount = @current_token_amount,
       total_tokens_bought = @total_tokens_bought,
       total_tokens_sold = @total_tokens_sold,
       strategy_id = COALESCE(@strategy_id, strategy_id),
       strategy_name = COALESCE(@strategy_name, strategy_name),
       closed_at = @closed_at,
       entry_token_amount = COALESCE(entry_token_amount, @entry_token_amount),
       entry_price_sol = COALESCE(entry_price_sol, @entry_price_sol),
       entry_price_usd = COALESCE(entry_price_usd, @entry_price_usd),
       last_price_sol = COALESCE(@last_price_sol, last_price_sol),
       last_price_usd = COALESCE(@last_price_usd, last_price_usd)
     WHERE position_id = @position_id`
  ).run({
    position_id: existing.position_id,
    wallet_alias: walletAlias,
    trade_uuid: tradeUuid,
    last_trade_at: executedAt,
    last_updated_at: now,
    current_token_amount: nextCurrent,
    total_tokens_bought: nextBought,
    total_tokens_sold: nextSold,
    strategy_id: event.strategyId || null,
    strategy_name: event.strategyName || null,
    closed_at: closedAt,
    entry_token_amount: entryTokenFallback,
    entry_price_sol: entryPriceSolFallback,
    entry_price_usd: entryPriceUsdFallback,
    last_price_sol: priceSolPerToken,
    last_price_usd: priceUsdPerToken,
  });
}

// === Helper upsert functions for risk and events ===
function upsertCoinRisk(mint, risk) {
  if (!mint || !risk || typeof risk !== "object") return;

  const now = Date.now();

  const rugged = risk.rugged ? 1 : 0;
  const riskScore = Number.isFinite(risk.score) ? Number(risk.score) : null;

  const snipers = risk.snipers || {};
  const insiders = risk.insiders || {};
  const dev = risk.dev || {};
  const fees = risk.fees || {};

  const snipersCount = Number.isFinite(snipers.count) ? Number(snipers.count) : 0;
  const snipersTotalBalance = Number.isFinite(snipers.totalBalance)
    ? Number(snipers.totalBalance)
    : 0;
  const snipersTotalPercent = Number.isFinite(snipers.totalPercentage)
    ? Number(snipers.totalPercentage)
    : 0;

  const insidersCount = Number.isFinite(insiders.count) ? Number(insiders.count) : 0;
  const insidersTotalBalance = Number.isFinite(insiders.totalBalance)
    ? Number(insiders.totalBalance)
    : 0;
  const insidersTotalPercent = Number.isFinite(insiders.totalPercentage)
    ? Number(insiders.totalPercentage)
    : 0;

  let top10Percent = Number(risk.top10);
  if (!Number.isFinite(top10Percent)) {
    top10Percent = null;
  } else {
    top10Percent = Math.round(top10Percent * 100) / 100;
  }

  const devPercent = Number.isFinite(dev.percentage) ? Number(dev.percentage) : 0;
  const devAmountTokens = Number.isFinite(dev.amount) ? Number(dev.amount) : 0;

  const feesTotalSol = Number.isFinite(fees.total) ? Number(fees.total) : 0;

  const risksJson = JSON.stringify(Array.isArray(risk.risks) ? risk.risks : []);

  const existing = db
    .prepare("SELECT * FROM risk WHERE coin_mint = ? LIMIT 1")
    .get(mint);

  if (!existing) {
    db.prepare(
      `INSERT INTO risk (
         coin_mint,
         rugged,
         riskScore,
         insertedAt,
         previousUpdatedAt,
         updatedAt,
         snipersCount,
         snipersTotalBalance,
         snipersTotalPercent,
         snipersCountDelta,
         snipersTotalBalanceDelta,
         snipersTotalPercentDelta,
         insidersCount,
         insidersTotalBalance,
         insidersTotalPercent,
         insidersCountDelta,
         insidersTotalBalanceDelta,
         insidersTotalPercentDelta,
         top10Percent,
         top10PercentDelta,
         devPercent,
         devPercentDelta,
         devAmountTokens,
         devAmountTokensDelta,
         feesTotalSol,
         feesTotalSolDelta,
         riskScoreDelta,
         risksJson
       ) VALUES (
         @coin_mint,
         @rugged,
         @riskScore,
         @insertedAt,
         @previousUpdatedAt,
         @updatedAt,
         @snipersCount,
         @snipersTotalBalance,
         @snipersTotalPercent,
         @snipersCountDelta,
         @snipersTotalBalanceDelta,
         @snipersTotalPercentDelta,
         @insidersCount,
         @insidersTotalBalance,
         @insidersTotalPercent,
         @insidersCountDelta,
         @insidersTotalBalanceDelta,
         @insidersTotalPercentDelta,
         @top10Percent,
         @top10PercentDelta,
         @devPercent,
         @devPercentDelta,
         @devAmountTokens,
         @devAmountTokensDelta,
         @feesTotalSol,
         @feesTotalSolDelta,
         @riskScoreDelta,
         @risksJson
       )`
    ).run({
      coin_mint: mint,
      rugged,
      riskScore,
      insertedAt: now,
      previousUpdatedAt: null,
      updatedAt: now,
      snipersCount,
      snipersTotalBalance,
      snipersTotalPercent,
      snipersCountDelta: 0,
      snipersTotalBalanceDelta: 0,
      snipersTotalPercentDelta: 0,
      insidersCount,
      insidersTotalBalance,
      insidersTotalPercent,
      insidersCountDelta: 0,
      insidersTotalBalanceDelta: 0,
      insidersTotalPercentDelta: 0,
      top10Percent,
      top10PercentDelta: 0,
      devPercent,
      devPercentDelta: 0,
      devAmountTokens,
      devAmountTokensDelta: 0,
      feesTotalSol,
      feesTotalSolDelta: 0,
      riskScoreDelta: 0,
      risksJson,
    });
    return;
  }

  const prevUpdatedAt = existing.updatedAt || existing.insertedAt || now;

  const snipersCountDelta = snipersCount - (Number(existing.snipersCount) || 0);
  const snipersTotalBalanceDelta =
    snipersTotalBalance - (Number(existing.snipersTotalBalance) || 0);
  const snipersTotalPercentDelta =
    snipersTotalPercent - (Number(existing.snipersTotalPercent) || 0);

  const insidersCountDelta = insidersCount - (Number(existing.insidersCount) || 0);
  const insidersTotalBalanceDelta =
    insidersTotalBalance - (Number(existing.insidersTotalBalance) || 0);
  const insidersTotalPercentDelta =
    insidersTotalPercent - (Number(existing.insidersTotalPercent) || 0);

  const top10PercentDelta =
    (top10Percent ?? 0) - (Number(existing.top10Percent ?? 0) || 0);

  const devPercentDelta = devPercent - (Number(existing.devPercent) || 0);
  const devAmountTokensDelta =
    devAmountTokens - (Number(existing.devAmountTokens) || 0);

  const feesTotalSolDelta = feesTotalSol - (Number(existing.feesTotalSol) || 0);

  const riskScoreDelta = (riskScore ?? 0) - (Number(existing.riskScore) || 0);

  db.prepare(
    `UPDATE risk SET
       rugged = @rugged,
       riskScore = @riskScore,
       previousUpdatedAt = @previousUpdatedAt,
       updatedAt = @updatedAt,
       snipersCount = @snipersCount,
       snipersTotalBalance = @snipersTotalBalance,
       snipersTotalPercent = @snipersTotalPercent,
       snipersCountDelta = @snipersCountDelta,
       snipersTotalBalanceDelta = @snipersTotalBalanceDelta,
       snipersTotalPercentDelta = @snipersTotalPercentDelta,
       insidersCount = @insidersCount,
       insidersTotalBalance = @insidersTotalBalance,
       insidersTotalPercent = @insidersTotalPercent,
       insidersCountDelta = @insidersCountDelta,
       insidersTotalBalanceDelta = @insidersTotalBalanceDelta,
       insidersTotalPercentDelta = @insidersTotalPercentDelta,
       top10Percent = @top10Percent,
       top10PercentDelta = @top10PercentDelta,
       devPercent = @devPercent,
       devPercentDelta = @devPercentDelta,
       devAmountTokens = @devAmountTokens,
       devAmountTokensDelta = @devAmountTokensDelta,
       feesTotalSol = @feesTotalSol,
       feesTotalSolDelta = @feesTotalSolDelta,
       riskScoreDelta = @riskScoreDelta,
       risksJson = @risksJson
     WHERE coin_mint = @coin_mint`
  ).run({
    coin_mint: mint,
    rugged,
    riskScore,
    previousUpdatedAt: prevUpdatedAt,
    updatedAt: now,
    snipersCount,
    snipersTotalBalance,
    snipersTotalPercent,
    snipersCountDelta,
    snipersTotalBalanceDelta,
    snipersTotalPercentDelta,
    insidersCount,
    insidersTotalBalance,
    insidersTotalPercent,
    insidersCountDelta,
    insidersTotalBalanceDelta,
    insidersTotalPercentDelta,
    top10Percent,
    top10PercentDelta,
    devPercent,
    devPercentDelta,
    devAmountTokens,
    devAmountTokensDelta,
    feesTotalSol,
    feesTotalSolDelta,
    riskScoreDelta,
    risksJson,
  });
}

function upsertCoinEvents(mint, events) {
  if (!mint || !events || typeof events !== "object") return;

  const now = Date.now();

  const stmtSelect = db.prepare(
    "SELECT * FROM events WHERE coin_mint = ? AND interval = ? LIMIT 1"
  );

  const stmtInsert = db.prepare(
    `INSERT INTO events (
       coin_mint,
       interval,
       insertedAt,
       previousUpdatedAt,
       updatedAt,
       priceChangePercentage,
       priceChangePercentageDelta,
       volumeSol,
       volumeSolDelta,
       volumeUsd,
       volumeUsdDelta,
       buysCount,
       buysCountDelta,
       sellsCount,
       sellsCountDelta,
       txnsCount,
       txnsCountDelta,
       holdersCount,
       holdersCountDelta
     ) VALUES (
       @coin_mint,
       @interval,
       @insertedAt,
       @previousUpdatedAt,
       @updatedAt,
       @priceChangePercentage,
       @priceChangePercentageDelta,
       @volumeSol,
       @volumeSolDelta,
       @volumeUsd,
       @volumeUsdDelta,
       @buysCount,
       @buysCountDelta,
       @sellsCount,
       @sellsCountDelta,
       @txnsCount,
       @txnsCountDelta,
       @holdersCount,
       @holdersCountDelta
     )`
  );

  const stmtUpdate = db.prepare(
    `UPDATE events SET
       previousUpdatedAt = @previousUpdatedAt,
       updatedAt = @updatedAt,
       priceChangePercentage = @priceChangePercentage,
       priceChangePercentageDelta = @priceChangePercentageDelta,
       volumeSol = @volumeSol,
       volumeSolDelta = @volumeSolDelta,
       volumeUsd = @volumeUsd,
       volumeUsdDelta = @volumeUsdDelta,
       buysCount = @buysCount,
       buysCountDelta = @buysCountDelta,
       sellsCount = @sellsCount,
       sellsCountDelta = @sellsCountDelta,
       txnsCount = @txnsCount,
       txnsCountDelta = @txnsCountDelta,
       holdersCount = @holdersCount,
       holdersCountDelta = @holdersCountDelta
     WHERE coin_mint = @coin_mint AND interval = @interval`
  );

  const tx = db.transaction((intervalEntries) => {
    for (const [intervalKey, payload] of intervalEntries) {
      if (!payload || typeof payload !== "object") continue;
      const interval = String(intervalKey);

      const priceChangePercentage = Number.isFinite(payload.priceChangePercentage)
        ? Number(payload.priceChangePercentage)
        : 0;

      const volumeSol = Number.isFinite(payload.volumeSol)
        ? Number(payload.volumeSol)
        : Number.isFinite(payload.volume?.quote)
          ? Number(payload.volume.quote)
          : 0;
      const volumeUsd = Number.isFinite(payload.volumeUsd)
        ? Number(payload.volumeUsd)
        : Number.isFinite(payload.volume?.usd)
          ? Number(payload.volume.usd)
          : 0;

      const buysCount = Number.isFinite(payload.buys) ? Number(payload.buys) : 0;
      const sellsCount = Number.isFinite(payload.sells) ? Number(payload.sells) : 0;
      const txnsCount = Number.isFinite(payload.txns) ? Number(payload.txns) : 0;
      const holdersCount = Number.isFinite(payload.wallets)
        ? Number(payload.wallets)
        : Number.isFinite(payload.holders)
          ? Number(payload.holders)
          : 0;

      const existing = stmtSelect.get(mint, interval);

      if (!existing) {
        stmtInsert.run({
          coin_mint: mint,
          interval,
          insertedAt: now,
          previousUpdatedAt: null,
          updatedAt: now,
          priceChangePercentage,
          priceChangePercentageDelta: 0,
          volumeSol,
          volumeSolDelta: 0,
          volumeUsd,
          volumeUsdDelta: 0,
          buysCount,
          buysCountDelta: 0,
          sellsCount,
          sellsCountDelta: 0,
          txnsCount,
          txnsCountDelta: 0,
          holdersCount,
          holdersCountDelta: 0,
        });
        continue;
      }

      const previousUpdatedAt = existing.updatedAt || existing.insertedAt || now;

      const priceChangePercentageDelta =
        priceChangePercentage - (Number(existing.priceChangePercentage) || 0);
      const volumeSolDelta = volumeSol - (Number(existing.volumeSol) || 0);
      const volumeUsdDelta = volumeUsd - (Number(existing.volumeUsd) || 0);
      const buysCountDelta = buysCount - (Number(existing.buysCount) || 0);
      const sellsCountDelta = sellsCount - (Number(existing.sellsCount) || 0);
      const txnsCountDelta = txnsCount - (Number(existing.txnsCount) || 0);
      const holdersCountDelta =
        holdersCount - (Number(existing.holdersCount) || 0);

      stmtUpdate.run({
        coin_mint: mint,
        interval,
        previousUpdatedAt,
        updatedAt: now,
        priceChangePercentage,
        priceChangePercentageDelta,
        volumeSol,
        volumeSolDelta,
        volumeUsd,
        volumeUsdDelta,
        buysCount,
        buysCountDelta,
        sellsCount,
        sellsCountDelta,
        txnsCount,
        txnsCountDelta,
        holdersCount,
        holdersCountDelta,
      });
    }
  });

  tx(Object.entries(events));
}

// Core BootyBox functions
const BootyBox = {
  recordScTradeEvent,
  applyScTradeEventToPositions,
  listWarchestWallets,
  getWarchestWalletByAlias,
  insertWarchestWallet,
  updateWarchestWalletColor,
  deleteWarchestWallet,
  listFundingWallets,
  getDefaultFundingWallet,
  setDefaultFundingWallet,
  listTrackedKolWallets,
  upsertKolWalletFromDossier,
  listWalletsByUsage,
  listAutoAttachedWarchestWallets,
  upsertProfileSnapshot,
  recordWalletAnalysis,
  getWalletAnalysisById,
  listWalletAnalysesByWallet,
  recordTradeAutopsy,
  getTradeAutopsyById,
  listTradeAutopsiesByWallet,
  recordAsk,
  recordTune,
  recordJobRun,
  getLatestWalletProfileVersion,
  persistWalletProfileArtifacts,

  /**
   * Inserts or updates a coin's metadata and trade-relevant info.
   * Accepts either flat or nested API format (token field optional).
   * Ensures coin is eligible for BuyOps/SellOps if marked 'complete'.
   * Fields include: mint, symbol, name, decimals, image, uri,
   * marketCapSol/Usd, priceSol/Usd, liquiditySol/Usd, status,
   * tokenCreatedAt, firstSeenAt, strictSocials, lastUpdated,
   * lastEvaluated, and buyScore.
   * @param {Object} coin - The coin object containing metadata fields.
   */
  addOrUpdateCoin(coin) {
    if (!coin) return;

    const now = Date.now();
    saveInput(coin);

    // Log data structure and normalize nested SolanaTracker payloads
    if (coin.token) {
      logger.debug(
        `[BootyBox] addOrUpdateCoin received nested coin object for ${coin.token.symbol} (${coin.token.mint})`
      );

      const token = coin.token || {};
      const pools = Array.isArray(coin.pools) ? coin.pools : [];
      const events = coin.events || {};
      const risk = coin.risk || {};

      const mainPool = pools.length > 0 ? pools[0] : null;

      const priceSol =
        (mainPool && mainPool.price && Number(mainPool.price.quote)) ||
        (Number(coin.price) || null);
      const priceUsd =
        mainPool && mainPool.price && Number(mainPool.price.usd)
          ? Number(mainPool.price.usd)
          : null;

      const liquiditySol =
        mainPool && mainPool.liquidity && Number(mainPool.liquidity.quote)
          ? Number(mainPool.liquidity.quote)
          : Number(coin.liquidity || 0) || 0;
      const liquidityUsd =
        mainPool && mainPool.liquidity && Number(mainPool.liquidity.usd)
          ? Number(mainPool.liquidity.usd)
          : null;

      const marketCapSol =
        mainPool && mainPool.marketCap && Number(mainPool.marketCap.quote)
          ? Number(mainPool.marketCap.quote)
          : null;
      const marketCapUsd =
        mainPool && mainPool.marketCap && Number(mainPool.marketCap.usd)
          ? Number(mainPool.marketCap.usd)
          : Number(coin.marketCap || 0) || 0;

      const creation = token.creation || {};
      const tokenCreatedAt =
        Number.isFinite(creation.created_time) && creation.created_time > 0
          ? creation.created_time * 1000
          : null;

      const strictSocials = token.strictSocials || null;

      coin = {
        ...token,
        pools,
        events,
        risk,
        status: coin.status || "incomplete",
        priceSol,
        priceUsd,
        liquiditySol,
        liquidityUsd,
        marketCapSol,
        marketCapUsd,
        tokenCreatedAt,
        strictSocials,
        lastUpdated: now,
      };
    }

    const {
      mint,
      symbol = "",
      name = "",
      decimals = 0,
      image = "",
      uri = "",
      status = "incomplete",
    } = coin;

    if (!mint || typeof mint !== "string") {
      logger.error(
        `[BootyBox] ❌ Invalid coin mint: ${mint} — aborting addOrUpdateCoin.`
      );
      return;
    }

    // Determine or preserve firstSeenAt
    let firstSeenAt = Number.isFinite(coin.firstSeenAt)
      ? Number(coin.firstSeenAt)
      : null;
    if (!firstSeenAt) {
      const existingFirstSeen = db
        .prepare("SELECT firstSeenAt FROM coins WHERE mint = ? LIMIT 1")
        .get(mint);
      if (existingFirstSeen && existingFirstSeen.firstSeenAt != null) {
        firstSeenAt = Number(existingFirstSeen.firstSeenAt) || null;
      } else {
        firstSeenAt = now;
      }
    }

    // Preserve existing buyScore if none provided
    let buyScore =
      typeof coin.buyScore === "number" && Number.isFinite(coin.buyScore)
        ? coin.buyScore
        : null;
    if (buyScore == null) {
      const existingRow = db
        .prepare(`SELECT buyScore FROM coins WHERE mint = ?`)
        .get(mint);
      if (
        existingRow &&
        typeof existingRow.buyScore === "number" &&
        Number.isFinite(existingRow.buyScore)
      ) {
        buyScore = existingRow.buyScore;
      }
    }
    if (buyScore == null) buyScore = 0;

    const tokenCreatedAt =
      Number.isFinite(coin.tokenCreatedAt) && coin.tokenCreatedAt > 0
        ? Number(coin.tokenCreatedAt)
        : null;

    const strictSocialsJson =
      coin.strictSocials != null ? JSON.stringify(coin.strictSocials) : null;

    const priceSol =
      Number.isFinite(coin.priceSol) && coin.priceSol > 0
        ? Number(coin.priceSol)
        : Number(coin.price || null) || null;
    const priceUsd =
      Number.isFinite(coin.priceUsd) && coin.priceUsd > 0
        ? Number(coin.priceUsd)
        : null;

    const liquiditySol =
      Number.isFinite(coin.liquiditySol) && coin.liquiditySol >= 0
        ? Number(coin.liquiditySol)
        : Number(coin.liquidity || 0) || 0;
    const liquidityUsd =
      Number.isFinite(coin.liquidityUsd) && coin.liquidityUsd >= 0
        ? Number(coin.liquidityUsd)
        : null;

    const marketCapSol =
      Number.isFinite(coin.marketCapSol) && coin.marketCapSol >= 0
        ? Number(coin.marketCapSol)
        : null;
    const marketCapUsd =
      Number.isFinite(coin.marketCapUsd) && coin.marketCapUsd >= 0
        ? Number(coin.marketCapUsd)
        : Number(coin.marketCap || 0) || 0;

    const lastUpdated = Number.isFinite(coin.lastUpdated)
      ? Number(coin.lastUpdated)
      : now;
    const lastEvaluated = Number.isFinite(coin.lastEvaluated)
      ? Number(coin.lastEvaluated)
      : 0;

    const stmt = db.prepare(`
      INSERT INTO coins (
        mint,
        symbol,
        name,
        decimals,
        image,
        uri,
        marketCap,
        status,
        lastUpdated,
        lastEvaluated,
        price,
        liquidity,
        buyScore,
        priceSol,
        priceUsd,
        liquiditySol,
        liquidityUsd,
        marketCapSol,
        marketCapUsd,
        tokenCreatedAt,
        firstSeenAt,
        strictSocials
      ) VALUES (
        @mint,
        @symbol,
        @name,
        @decimals,
        @image,
        @uri,
        @marketCap,
        @status,
        @lastUpdated,
        @lastEvaluated,
        @price,
        @liquidity,
        @buyScore,
        @priceSol,
        @priceUsd,
        @liquiditySol,
        @liquidityUsd,
        @marketCapSol,
        @marketCapUsd,
        @tokenCreatedAt,
        @firstSeenAt,
        @strictSocials
      )
      ON CONFLICT(mint) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        decimals = excluded.decimals,
        image = excluded.image,
        uri = excluded.uri,
        marketCap = excluded.marketCap,
        status = excluded.status,
        lastUpdated = excluded.lastUpdated,
        lastEvaluated = excluded.lastEvaluated,
        price = excluded.price,
        liquidity = excluded.liquidity,
        buyScore = excluded.buyScore,
        priceSol = excluded.priceSol,
        priceUsd = excluded.priceUsd,
        liquiditySol = excluded.liquiditySol,
        liquidityUsd = excluded.liquidityUsd,
        marketCapSol = excluded.marketCapSol,
        marketCapUsd = excluded.marketCapUsd,
        tokenCreatedAt = excluded.tokenCreatedAt,
        firstSeenAt = excluded.firstSeenAt,
        strictSocials = excluded.strictSocials
    `);

    stmt.run({
      mint,
      symbol,
      name,
      decimals,
      image,
      uri,
      // legacy fields: retain but make semantics explicit in code
      marketCap: marketCapUsd,
      status,
      lastUpdated,
      lastEvaluated,
      price: priceSol,
      liquidity: liquiditySol,
      buyScore,
      // new explicit SOL/USD + metadata fields
      priceSol,
      priceUsd,
      liquiditySol,
      liquidityUsd,
      marketCapSol,
      marketCapUsd,
      tokenCreatedAt,
      firstSeenAt,
      strictSocials: strictSocialsJson,
    });

    const row = db.prepare(`SELECT * FROM coins WHERE mint = ?`).get(mint);
    if (!row) {
      logger.error(
        `[BootyBox] ❌ Insert/update for ${mint} failed. Coin data: ${JSON.stringify(
          coin,
          null,
          2
        )}`
      );
      return;
    }

    const coinExists = db
      .prepare(`SELECT 1 FROM coins WHERE mint = ?`)
      .get(mint);
    if (!coinExists) {
      logger.error(
        `[BootyBox] ❌ Coin insert failed or missing, skipping pool/event/risk insert for mint: ${mint}`
      );
      return;
    }

    // Insert/update pools for this coin (batched)
    if (Array.isArray(coin.pools) && coin.pools.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO pools (
          coin_mint,
          liquidity_quote,
          liquidity_usd,
          price_quote,
          price_usd,
          tokenSupply,
          lpBurn,
          marketCap_quote,
          marketCap_usd,
          market,
          quoteToken,
          createdAt,
          lastUpdated,
          txns_buys,
          txns_sells,
          txns_total,
          volume_quote,
          volume24h_quote,
          deployer
        ) VALUES (
          @coin_mint,
          @liquidity_quote,
          @liquidity_usd,
          @price_quote,
          @price_usd,
          @tokenSupply,
          @lpBurn,
          @marketCap_quote,
          @marketCap_usd,
          @market,
          @quoteToken,
          @createdAt,
          @lastUpdated,
          @txns_buys,
          @txns_sells,
          @txns_total,
          @volume_quote,
          @volume24h_quote,
          @deployer
        )
        ON CONFLICT(coin_mint, market) DO UPDATE SET
          liquidity_quote  = excluded.liquidity_quote,
          liquidity_usd    = excluded.liquidity_usd,
          price_quote      = excluded.price_quote,
          price_usd        = excluded.price_usd,
          tokenSupply      = excluded.tokenSupply,
          lpBurn           = excluded.lpBurn,
          marketCap_quote  = excluded.marketCap_quote,
          marketCap_usd    = excluded.marketCap_usd,
          market           = excluded.market,
          quoteToken       = excluded.quoteToken,
          createdAt        = excluded.createdAt,
          lastUpdated      = excluded.lastUpdated,
          txns_buys        = excluded.txns_buys,
          txns_sells       = excluded.txns_sells,
          txns_total       = excluded.txns_total,
          volume_quote     = excluded.volume_quote,
          volume24h_quote  = excluded.volume24h_quote,
          deployer         = excluded.deployer
      `);

      const tx = db.transaction((pools) => {
        for (const pool of pools) {
          if (!pool || typeof pool !== "object") continue;

          insertStmt.run({
            coin_mint: mint,
            liquidity_quote: pool.liquidity?.quote ?? null,
            liquidity_usd: pool.liquidity?.usd ?? null,
            price_quote: pool.price?.quote ?? null,
            price_usd: pool.price?.usd ?? null,
            tokenSupply: pool.tokenSupply ?? null,
            lpBurn: pool.lpBurn ?? null,
            marketCap_quote: pool.marketCap?.quote ?? null,
            marketCap_usd: pool.marketCap?.usd ?? null,
            market: pool.market ?? null,
            quoteToken: pool.quoteToken ?? null,
            createdAt: pool.createdAt ?? null,
            lastUpdated: Date.now(),
            txns_buys: pool.txns?.buys ?? null,
            txns_sells: pool.txns?.sells ?? null,
            txns_total: pool.txns?.total ?? null,
            volume_quote: pool.txns?.volume ?? null,
            volume24h_quote: pool.txns?.volume24h ?? null,
            deployer: pool.deployer ?? null,
          });
        }
      });

      tx(coin.pools);
    }

    // Upsert events if provided
    if (coin.events && typeof coin.events === "object") {
      try {
        upsertCoinEvents(mint, coin.events);
      } catch (err) {
        logger.warn(
          `[BootyBox] Failed to upsert events for ${mint}: ${err.message}`
        );
      }
    }

    // Upsert risk metrics if present
    if (coin.risk && typeof coin.risk === "object") {
      try {
        upsertCoinRisk(mint, coin.risk);
      } catch (err) {
        logger.warn(
          `[BootyBox] Failed to upsert risk metrics for ${mint}: ${err.message}`
        );
      }
    }
  },

  /**
   * Updates specific price-related fields for a coin,
   * and always tags lastUpdated.
   * @param {string} mint – The token mint address.
   * @param {Object} fields – Optional fields: price, liquidity, marketCap, buyScore.
   */
  updateCoinPriceFields(mint, fields) {
    const allowed = ["price", "liquidity", "marketCap", "buyScore"];
    const updates = Object.entries(fields)
      .filter(([key]) => allowed.includes(key))
      .map(([key]) => `${key} = @${key}`)
      .join(", ");

    if (!updates) return;

    // always update lastUpdated too
    const stmt = db.prepare(`
    UPDATE coins
    SET ${updates},
        lastUpdated = @lastUpdated
    WHERE mint = @mint
  `);

    stmt.run({ mint, lastUpdated: Date.now(), ...fields });
  },

  /**
   * Deletes coins with zero buyScore that have no open positions.
   * @returns {number} Number of deleted rows.
   */
  pruneZeroBuyScoreCoins() {
    // Find all zero-score coins not in positions
    const rows = db
      .prepare(
        `
      SELECT mint FROM coins
      WHERE buyScore = 0
        AND mint NOT IN (SELECT coin_mint FROM positions)
    `
      )
      .all();
    const mints = rows.map((r) => r.mint);
    let deletedCount = 0;
    // Define tables and their coin key columns to clean up references
    const refTables = [
      { table: "buys", column: "coin_mint" },
      { table: "sells", column: "coin_mint" },
      { table: "pools", column: "coin_mint" },
      { table: "events", column: "coin_mint" },
      { table: "risk", column: "coin_mint" },
      { table: "chart_data", column: "coin_mint" },
      { table: "indicators", column: "coin_mint" },
      { table: "pnl", column: "coin_mint" },
      { table: "trades", column: "mint" },
    ];
    for (const mint of mints) {
      // Delete all referencing rows
      for (const { table, column } of refTables) {
        db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(mint);
      }
      // Delete the coin itself
      const result = db.prepare(`DELETE FROM coins WHERE mint = ?`).run(mint);
      if (result.changes) deletedCount++;
    }
    return deletedCount;
  },

  /**
   * Returns the total number of coins in the database.
   * @returns {number}
   */
  getCoinCount() {
    const row = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM coins
    `
      )
      .get();
    return row.count;
  },

  /**
   * Upserts a market name into the markets catalog.
   * Increments seenCount and updates timestamps; creates row if missing.
   * @param {string} marketName
   */
  upsertMarket(marketName) {
    if (!marketName || typeof marketName !== "string") return;
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO markets (name, firstSeen, lastSeen, seenCount)
      VALUES (@name, @now, @now, 1)
      ON CONFLICT(name) DO UPDATE SET
        lastSeen = excluded.lastSeen,
        seenCount = seenCount + 1
    `
    ).run({ name: marketName, now });
  },

  /**
   * Returns eligible coins not currently held, ordered by least recently evaluated.
   * Accepts either a numeric limit (legacy) or an options object with
   * { limit, minBuyScore }.
   * @param {number|Object} [options]
   * @returns {Array<Object>}
   */
  queryEligibleCoinsForBuy(options) {
    // Prune zero buyScore coins
    this.pruneZeroBuyScoreCoins();

    let limit = 100;
    let minBuyScore = 20;

    // Backwards compatibility: if a number is passed, treat it as the limit
    if (typeof options === "number") {
      limit = options;
    } else if (options && typeof options === "object") {
      if (Number.isFinite(options.limit)) {
        limit = options.limit;
      }
      if (Number.isFinite(options.minBuyScore)) {
        minBuyScore = options.minBuyScore;
      }
    }

    return db
      .prepare(
        `
      SELECT * FROM coins
      WHERE status = 'complete'
        AND buyScore >= ?
        AND mint NOT IN (SELECT coin_mint FROM positions)
      ORDER BY buyScore DESC, lastUpdated ASC
      LIMIT ?
    `
      )
      .all(minBuyScore, limit);
  },

  /**
   * Retrieves all currently open positions joined with coin metadata.
   * Only includes positions where the coin status is 'complete'.
   * @returns {Array<Object>} List of open position records with metadata.
   */
  getOpenPositions() {
    return db
      .prepare(
        `
      SELECT positions.*, coins.symbol, coins.name, coins.decimals, coins.image, coins.status,
             coins.price AS coin_price
      FROM positions
      JOIN coins ON coins.mint = positions.coin_mint
      WHERE coins.status = 'complete'
    `
      )
      .all();
  },

  /**
   * Adds or replaces a tracked open position.
   * @param {Object} position - The position data (mint, entry price, SL, etc.).
   */
  /**
   * Adds or replaces a tracked open position.
   * Prevents overwriting highestPrice if the incoming value is lower.
   * @param {Object} position - The position data (mint, entry price, SL, etc.).
   */
  addPosition(position) {
    const { coin_mint, highestPrice: incomingHighest = 0 } = position;

    // New mapping for extended columns
    const entryAmt = position.entryAmt ?? position.amount ?? null;
    const holdingAmt = position.holdingAmt ?? position.amount ?? null;
    const walletId = position.walletId ?? null;
    const walletAlias = position.walletAlias ?? null;
    const entryPriceSol = position.entryPriceSol ?? position.entryPrice ?? null;
    const currentPriceSol = position.currentPriceSol ?? null;
    const currentPriceUsd = position.currentPriceUsd ?? null;
    const highestPriceSol = position.highestPriceSol ?? incomingHighest ?? null;
    const source = position.source ?? null;
    const lastUpdated = Date.now();

    const existing = db
      .prepare(
        `SELECT highestPrice, trade_uuid FROM positions WHERE coin_mint = ?`
      )
      .get(coin_mint);
    const currentHighest = existing ? existing.highestPrice ?? 0 : 0;
    const existingUuid = existing ? existing.trade_uuid : null;

    let trade_uuid = position.trade_uuid || existingUuid || null;
    if (!trade_uuid) trade_uuid = resolveTradeUuid(coin_mint);
    if (trade_uuid) {
      tradeUuidMap.set(coin_mint, trade_uuid);
      deletePendingTradeUuid(coin_mint);
    }

    // Determine final highestPrice based on existence and comparison
    const finalHighest = existing
      ? Math.max(incomingHighest, currentHighest)
      : incomingHighest;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO positions
      (coin_mint, trade_uuid, entryPrice, entryPriceUSD, highestPrice, amount, sl, previousRsi, timestamp, lastValidated
      , entryAmt, holdingAmt, walletId, walletAlias,
        entryPriceSol, currentPriceSol, currentPriceUsd,
        highestPriceSol, source, lastUpdated
      )
      VALUES
      (@coin_mint, @trade_uuid, @entryPrice, @entryPriceUSD, @highestPrice, @amount, @sl, @previousRsi, @timestamp, @lastValidated
      , @entryAmt, @holdingAmt, @walletId, @walletAlias,
        @entryPriceSol, @currentPriceSol, @currentPriceUsd,
        @highestPriceSol, @source, @lastUpdated
      )
    `);
    stmt.run({
      ...position,
      trade_uuid,
      entryPriceUSD: position.entryPriceUSD ?? null,
      highestPrice: finalHighest,
      previousRsi: position.previousRsi ?? null,
      entryAmt,
      holdingAmt,
      walletId,
      walletAlias,
      entryPriceSol,
      currentPriceSol,
      currentPriceUsd,
      highestPriceSol,
      source,
      lastUpdated,
    });
  },

  /**
   * Deletes a position by coin mint, used when a position is sold.
   * @param {string} mint - The token mint of the coin.
   */
  removePosition(mint) {
    db.prepare(`DELETE FROM positions WHERE coin_mint = ?`).run(mint);
  },

  /**
   * Logs a buy transaction to the buy history table.
   * @param {Object} buy - Buy record including price, qty, timestamp, txid, and fees (lamports).
   */
  logBuy(buy) {
    if (!buy.price || buy.price === 0) {
      logger.warn(
        `[BootyBox] Ignoring buy log — no valid price for TXID: ${buy.txid}`
      );
      return;
    }
    const exists = db
      .prepare(`SELECT 1 FROM buys WHERE txid = ?`)
      .get(buy.txid);
    if (exists) {
      logger.warn(`⚠️ [BootyBox] Duplicate BUY tx skipped: ${buy.txid}`);
      return;
    }

    let trade_uuid = buy.trade_uuid || resolveTradeUuid(buy.coin_mint);
    if (trade_uuid) {
      tradeUuidMap.set(buy.coin_mint, trade_uuid);
      deletePendingTradeUuid(buy.coin_mint);
    }

    const timestamp = buy.timestamp || Date.now();
    const stmt = db.prepare(`
      INSERT INTO buys (
        coin_mint,
        trade_uuid,
        price,
        priceUsd,
        qty,
        timestamp,
        txid,
        fees,
        feesUsd,
        solUsdPrice,
        slippage,
        priceImpact,
        hiddenTax,
        executionPrice,
        currentPrice
      ) VALUES (
        @coin_mint,
        @trade_uuid,
        @price,
        @priceUsd,
        @qty,
        @timestamp,
        @txid,
        @fees,
        @feesUsd,
        @solUsdPrice,
        @slippage,
        @priceImpact,
        @hiddenTax,
        @executionPrice,
        @currentPrice
      )
    `);
    stmt.run({
      ...buy,
      trade_uuid,
      timestamp,
      solUsdPrice: buy.solUsdPrice ?? null,
      slippage: buy.slippage ?? null,
      priceImpact: buy.priceImpact ?? null,
      hiddenTax: buy.hiddenTax ?? null,
      executionPrice: buy.executionPrice ?? null,
      currentPrice: buy.currentPrice ?? null,
    });
    // Also log to trades table
    const wallet = buy.wallet || defaultWalletPublicKey || null;
    if (!wallet) {
      logger.warn(
        chalk.bgYellow.black(
          `[BootyBox] WARNING: Missing wallet for BUY on mint ${buy.coin_mint}. Trade data will be incomplete and analytics may be fucked.`
        )
      );
    }
    BootyBox.insertTrades(buy.coin_mint, wallet, [
      {
        trade_uuid,
        tx: buy.txid,
        wallet,
        amount: buy.qty,
        priceUsd: buy.priceUsd,
        volume: buy.qty * buy.priceUsd,
        volumeSol: buy.qty * buy.price,
        type: "buy",
        time: timestamp,
        program: buy.program || "swap",
        pools: Array.isArray(buy.pools) ? buy.pools : [],
      },
    ]);
  },

  /**
   * Logs a sell transaction to the sell history table.
   * @param {Object} sell - Sell record including price, priceUsd, qty, timestamp, txid, pnl, pnlPct, fees, feesUsd.
   */
  logSell(sell) {
    const exists = db
      .prepare(`SELECT 1 FROM sells WHERE txid = ?`)
      .get(sell.txid);
    if (exists) {
      logger.warn(`⚠️ [BootyBox] Duplicate SELL tx skipped: ${sell.txid}`);
      return;
    }

    let trade_uuid = sell.trade_uuid || resolveTradeUuid(sell.coin_mint);
    if (trade_uuid) {
      tradeUuidMap.set(sell.coin_mint, trade_uuid);
      deletePendingTradeUuid(sell.coin_mint);
    }

    const timestamp = sell.timestamp || Date.now();
    const stmt = db.prepare(`
      INSERT INTO sells (
        coin_mint,
        trade_uuid,
        price,
        priceUsd,
        qty,
        timestamp,
        txid,
        pnl,
        pnlPct,
        fees,
        feesUsd,
        solUsdPrice,
        slippage,
        priceImpact,
        hiddenTax,
        executionPrice,
        currentPrice
      ) VALUES (
        @coin_mint,
        @trade_uuid,
        @price,
        @priceUsd,
        @qty,
        @timestamp,
        @txid,
        @pnl,
        @pnlPct,
        @fees,
        @feesUsd,
        @solUsdPrice,
        @slippage,
        @priceImpact,
        @hiddenTax,
        @executionPrice,
        @currentPrice
      )
    `);
    stmt.run({
      ...sell,
      trade_uuid,
      timestamp,
      solUsdPrice: sell.solUsdPrice ?? null,
      slippage: sell.slippage ?? null,
      priceImpact: sell.priceImpact ?? null,
      hiddenTax: sell.hiddenTax ?? null,
      executionPrice: sell.executionPrice ?? null,
      currentPrice: sell.currentPrice ?? null,
    });
    // Also log to trades table
    const wallet = sell.wallet || defaultWalletPublicKey || null;
    if (!wallet) {
      logger.warn(
        chalk.bgYellow.black(
          `[BootyBox] WARNING: Missing wallet for SELL on mint ${sell.coin_mint}. Trade data will be incomplete and analytics may be fucked.`
        )
      );
    }
    BootyBox.insertTrades(sell.coin_mint, wallet, [
      {
        trade_uuid,
        tx: sell.txid,
        wallet,
        amount: sell.qty,
        priceUsd: sell.priceUsd,
        volume: sell.qty * sell.priceUsd,
        volumeSol: sell.qty * sell.price,
        type: "sell",
        time: timestamp,
        program: sell.program || "swap",
        pools: Array.isArray(sell.pools) ? sell.pools : [],
      },
    ]);
    clearTradeUuid(sell.coin_mint);
  },

  getLatestBuyByMint(mint) {
    return db
      .prepare(
        "SELECT * FROM buys WHERE coin_mint = ? ORDER BY timestamp DESC LIMIT 1"
      )
      .get(mint);
  },

  getLatestSellByMint(mint) {
    return db
      .prepare(
        "SELECT * FROM sells WHERE coin_mint = ? ORDER BY timestamp DESC LIMIT 1"
      )
      .get(mint);
  },

  /**
   * Logs a buy or sell evaluation result.
   * @param {Object} e - Evaluation data.
   * Fields: evalId, timestamp, tokenSymbol, mint, strategy, evalType, decision, reason, blueprintCatalog, blueprintActive, gateResults
   */
  logEvaluation(e) {
    const stmt = db.prepare(`
      INSERT INTO evaluations (
        eval_id, timestamp, tokenSymbol, mint, strategy,
        evalType, decision, reason,
        blueprintCatalog, blueprintActive, gateResults
      ) VALUES (
        @evalId, @timestamp, @tokenSymbol, @mint, @strategy,
        @evalType, @decision, @reason,
        @blueprintCatalog, @blueprintActive, @gateResults
      )
    `);
    stmt.run({
      evalId: e.evalId,
      timestamp: e.timestamp || Date.now(),
      tokenSymbol: e.tokenSymbol,
      mint: e.mint,
      strategy: e.strategy,
      evalType: e.evalType,
      decision: e.decision ? 1 : 0,
      reason: e.reason || "",
      blueprintCatalog: JSON.stringify(e.blueprintCatalog || {}),
      blueprintActive: JSON.stringify(e.blueprintActive || {}),
      gateResults: JSON.stringify(e.gateResults || {}),
    });
  },

  /**
   * Retrieves a coin’s full metadata by mint address.
   * @param {string} mint - The token mint address.
   * @returns {Object|null} The coin record, if found.
   */
  getCoinByMint(mint) {
    return db.prepare(`SELECT * FROM coins WHERE mint = ?`).get(mint);
  },

  /**
   * Gets the processing status of a coin (incomplete, complete, failed, blacklist).
   * @param {string} mint - The token mint address.
   * @returns {string|null} The current status, or null if coin not found.
   */
  getCoinStatus(mint) {
    const coin = db
      .prepare(`SELECT status FROM coins WHERE mint = ?`)
      .get(mint);
    return coin ? coin.status : null;
  },

  /**
   * Updates the status and timestamp of a coin in the DB.
   * @param {string} mint - The token mint address.
   * @param {string} status - New status (incomplete, complete, failed, blacklist).
   */
  updateCoinStatus(mint, status) {
    db.prepare(
      `UPDATE coins SET status = ?, lastUpdated = ? WHERE mint = ?`
    ).run(status, Date.now(), mint);
  },

  /**
   * Updates the lastEvaluated timestamp for a coin,
   * and tags lastUpdated at the same time.
   * Should be called after a coin is evaluated by BuyOps or SellOps.
   * @param {string} mint – The token mint address.
   */
  updateLastEvaluated(mint) {
    const ts = Date.now();
    db.prepare(
      `
    UPDATE coins
    SET lastEvaluated = @ts,
        lastUpdated   = @ts
    WHERE mint = @mint
  `
    ).run({ ts, mint });
  },

  /**
   * Inserts or updates the PnL row for a given mint.
   * If the row already exists, per‐trade values are added to running totals,
   * transaction counts incremented, and timestamps updated.
   *
   * @param {string} mint    – The token mint
   * @param {Object} pnlData – Per‐trade PnL data with keys:
   *   holding, held, sold, sold_usd, realized, unrealized,
   *   fees_sol, fees_usd, total, total_sold, total_invested,
   *   average_buy_amount, current_value, cost_basis,
   *   first_trade_time, last_buy_time, last_sell_time, last_trade_time,
   *   buy_transactions, sell_transactions, total_transactions, lastUpdated
   */
  updatePnL(mint, pnlData) {
    if (!mint) return;
    pnlData = pnlData || {};
    // Normalize timestamps and transaction counts
    const now = Date.now();
    const lastUpdated = pnlData.lastUpdated || now;
    const buyTx =
      pnlData.buy_transactions != null ? pnlData.buy_transactions : 0;
    const sellTx =
      pnlData.sell_transactions != null ? pnlData.sell_transactions : 0;
    const totalTx =
      pnlData.total_transactions != null
        ? pnlData.total_transactions
        : buyTx + sellTx;
    const hasTrade = buyTx > 0 || sellTx > 0;
    const firstTradeTime =
      pnlData.first_trade_time || (hasTrade ? lastUpdated : null);
    const lastBuyTime =
      pnlData.last_buy_time || (buyTx > 0 ? lastUpdated : null);
    const lastSellTime =
      pnlData.last_sell_time || (sellTx > 0 ? lastUpdated : null);
    const lastTradeTime =
      pnlData.last_trade_time || (hasTrade ? lastUpdated : null);

    const upsert = db.prepare(`
      INSERT INTO pnl (
        coin_mint, holding, held, sold, sold_usd, realized, unrealized,
        fees_sol, fees_usd, total, total_sold, total_invested,
        average_buy_amount, current_value, cost_basis,
        first_trade_time, last_buy_time, last_sell_time,
        last_trade_time, buy_transactions, sell_transactions,
        total_transactions, lastUpdated
      ) VALUES (
        @coin_mint, @holding, @held, @sold, @sold_usd, @realized, @unrealized,
        @fees_sol, @fees_usd, @total, @total_sold, @total_invested,
        @average_buy_amount, @current_value, @cost_basis,
        @first_trade_time, @last_buy_time, @last_sell_time,
        @last_trade_time, @buy_transactions, @sell_transactions,
        @total_transactions, @lastUpdated
      )
      ON CONFLICT(coin_mint) DO UPDATE SET
        holding           = holding + excluded.holding,
        held              = held + excluded.held,
        sold              = sold + excluded.sold,
        sold_usd          = sold_usd + excluded.sold_usd,
        realized          = realized + excluded.realized,
        unrealized        = excluded.unrealized,
        fees_sol          = fees_sol + excluded.fees_sol,
        fees_usd          = fees_usd + excluded.fees_usd,
        total             = total + excluded.total,
        total_sold        = total_sold + excluded.total_sold,
        total_invested    = total_invested + excluded.total_invested,
        average_buy_amount= excluded.average_buy_amount,
        current_value     = excluded.current_value,
        cost_basis        = excluded.cost_basis,
        first_trade_time  = COALESCE(first_trade_time, excluded.first_trade_time),
        last_buy_time     = COALESCE(excluded.last_buy_time, last_buy_time),
        last_sell_time    = COALESCE(excluded.last_sell_time, last_sell_time),
        last_trade_time   = COALESCE(excluded.last_trade_time, last_trade_time),
        buy_transactions  = buy_transactions + excluded.buy_transactions,
        sell_transactions = sell_transactions + excluded.sell_transactions,
        total_transactions= total_transactions + excluded.total_transactions,
        lastUpdated       = excluded.lastUpdated;
    `);
    // Build a complete params object so every named SQL placeholder is provided
    const params = {
      coin_mint: mint,
      holding: pnlData.holding || 0,
      held: pnlData.held || 0,
      sold: pnlData.sold || 0,
      sold_usd: pnlData.sold_usd || 0,
      realized: pnlData.realized || 0,
      unrealized: pnlData.unrealized || 0,
      fees_sol: pnlData.fees_sol || 0,
      fees_usd: pnlData.fees_usd || 0,
      total: pnlData.total || 0,
      total_sold: pnlData.total_sold || 0,
      total_invested: pnlData.total_invested || 0,
      average_buy_amount: pnlData.average_buy_amount || 0,
      current_value: pnlData.current_value || 0,
      cost_basis: pnlData.cost_basis || 0,
      first_trade_time: firstTradeTime,
      last_buy_time: lastBuyTime,
      last_sell_time: lastSellTime,
      last_trade_time: lastTradeTime,
      buy_transactions: buyTx,
      sell_transactions: sellTx,
      total_transactions: totalTx,
      lastUpdated: lastUpdated,
    };
    upsert.run(params);

    // Bump parent coin's timestamp to preserve it
    db.prepare(
      `
      UPDATE coins
      SET lastUpdated = ?
      WHERE mint = ?
    `
    ).run(lastUpdated, mint);

    // Also refresh the position’s lastValidated so cleanup keeps it alive
    db.prepare(
      `
      UPDATE positions
      SET lastValidated = ?
      WHERE coin_mint = ?
    `
    ).run(lastUpdated, mint);
  },

  /**
   * Stores an array of trades for a given mint and wallet.
   * Replaces existing trades for that pair.
   * @param {string} mint
   * @param {string} wallet
   * @param {Array} trades
   */
  insertTrades(mint, wallet, trades) {
    if (!Array.isArray(trades) || trades.length === 0) return;

    const fallbackWallet =
      normalizeWalletField(wallet) ||
      normalizeWalletField(defaultWalletPublicKey);
    const fallbackUuid = resolveTradeUuid(mint);

    const insertStmt = db.prepare(`
      INSERT INTO trades (
        trade_uuid, tx, mint, wallet, amount, priceUsd, volume, volumeSol, type, time, program, pools
      ) VALUES (
        @trade_uuid, @tx, @mint, @wallet, @amount, @priceUsd, @volume, @volumeSol, @type, @time, @program, @pools
      )
      ON CONFLICT(tx) DO UPDATE SET
        trade_uuid = COALESCE(excluded.trade_uuid, trades.trade_uuid),
        wallet = COALESCE(excluded.wallet, trades.wallet),
        amount = COALESCE(excluded.amount, trades.amount),
        priceUsd = COALESCE(excluded.priceUsd, trades.priceUsd),
        volume = COALESCE(excluded.volume, trades.volume),
        volumeSol = COALESCE(excluded.volumeSol, trades.volumeSol),
        type = COALESCE(excluded.type, trades.type),
        time = COALESCE(excluded.time, trades.time),
        program = COALESCE(excluded.program, trades.program),
        pools = COALESCE(excluded.pools, trades.pools)
    `);

    const insertMany = db.transaction((tradeList) => {
      for (const trade of tradeList) {
        const tradeUuid =
          trade.trade_uuid || fallbackUuid || resolveTradeUuid(mint);
        if (tradeUuid) {
          tradeUuidMap.set(mint, tradeUuid);
          deletePendingTradeUuid(mint);
        }
        const walletValue =
          normalizeWalletField(trade.wallet) || fallbackWallet || null;
        if (!walletValue) {
          logger.warn(
            chalk.bgYellow.black(
              `[BootyBox] WARNING: Missing wallet for trade on mint ${mint}. Trade data will be incomplete and analytics may be corrupted.`
            )
          );
        }
        insertStmt.run({
          trade_uuid: tradeUuid || null,
          tx: trade.tx,
          mint,
          wallet: walletValue,
          amount: Number.isFinite(trade.amount) ? trade.amount : null,
          priceUsd: Number.isFinite(trade.priceUsd) ? trade.priceUsd : null,
          volume: Number.isFinite(trade.volume) ? trade.volume : null,
          volumeSol: Number.isFinite(trade.volumeSol) ? trade.volumeSol : null,
          type: trade.type || null,
          time: trade.time || null,
          program: trade.program || null,
          pools: JSON.stringify(Array.isArray(trade.pools) ? trade.pools : []),
        });
      }
    });

    insertMany(trades);
  },

  /**
   * Retrieves all coins, optionally filtered by status.
   * @param {string|null} status - Optional status to filter by (e.g. 'complete').
   * @returns {Array<Object>} Array of coin records.
   */
  queryAllCoins(status = null) {
    if (status) {
      return db.prepare(`SELECT * FROM coins WHERE status = ?`).all(status);
    }
    return db.prepare(`SELECT * FROM coins`).all();
  },

  /**
   * Retrieves a specific open position and its coin metadata by mint.
   * @param {string} mint - The coin mint address.
   * @returns {Object|null} The position with coin metadata, or null if not found.
   */
  getBootyByMint(mint) {
    return db
      .prepare(
        `
      SELECT positions.*, coins.symbol, coins.name, coins.decimals, coins.image, coins.status
      FROM positions
      JOIN coins ON coins.mint = positions.coin_mint
      WHERE coins.status = 'complete' AND positions.coin_mint = ?
    `
      )
      .get(mint);
  },

    /**
   * Retrieves the highest scoring eligible coin for a potential buy.
   * Excludes coins already in open positions and those not marked 'complete'.
   * @param {Object} [options]
   * @param {number} [options.minBuyScore=20]
   * @returns {Object|null} The top scoring coin, or null if none found.
   */
  getTopScoringCoin(options = {}) {
    const minBuyScore = Number.isFinite(options.minBuyScore)
      ? options.minBuyScore
      : 20;

    return db
      .prepare(
        `
      SELECT * FROM coins
      WHERE status = 'complete'
        AND buyScore >= ?
        AND mint NOT IN (SELECT coin_mint FROM positions)
      ORDER BY buyScore DESC
      LIMIT 1
    `
      )
      .get(minBuyScore);
  },

  /**
   * Gets the amount of tokens held for a given mint from the positions table.
   * Looks up the 'amount' column where coin_mint = mint.
   * @param {string} mint - The token mint address.
   * @returns {number} The numeric amount held, or 0 if not found.
   */
  getTokenAmount(mint) {
    const result = db
      .prepare(`SELECT amount FROM positions WHERE coin_mint = ?`)
      .get(mint);
    return result && typeof result.amount === "number" ? result.amount : 0;
  },

  /**
   * Marks a swap as pending to prevent overbuying before confirmation.
   * @param {string} mint - The mint of the coin being bought.
   */
  markPendingSwap(mint, walletKey) {
    const normalizedMint = typeof mint === "string" ? mint.trim() : "";
    if (!normalizedMint) return;
    const key =
      walletKey && typeof walletKey === "string" && walletKey.trim()
        ? walletKey.trim()
        : "__global__";
    let set = pendingSwaps.get(normalizedMint);
    if (!set) {
      set = new Set();
      pendingSwaps.set(normalizedMint, set);
    }
    set.add(key);
  },

  /**
   * Clears a pending swap once confirmed or failed.
   * @param {string} mint - The mint of the coin that was processed.
   */
  clearPendingSwap(mint, walletKey) {
    const normalizedMint = typeof mint === "string" ? mint.trim() : "";
    if (!normalizedMint) return;
    const key =
      walletKey && typeof walletKey === "string" && walletKey.trim()
        ? walletKey.trim()
        : "__global__";
    const set = pendingSwaps.get(normalizedMint);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) {
      pendingSwaps.delete(normalizedMint);
    }
  },

  /**
   * Gets the current number of pending swaps.
   * @returns {number} The count of currently pending swaps.
   */
  getPendingSwapCount() {
    let count = 0;
    pendingSwaps.forEach((set) => {
      count += set.size;
    });
    return count;
  },

  /**
   * Checks whether a swap is currently pending for a mint.
   * Useful to avoid duplicate buys while confirmation/resync is in flight.
   * @param {string} mint
   * @returns {boolean}
   */
  isSwapPending(mint, walletKey) {
    const normalizedMint = typeof mint === "string" ? mint.trim() : "";
    if (!normalizedMint) return false;
    const key =
      walletKey && typeof walletKey === "string" && walletKey.trim()
        ? walletKey.trim()
        : "__global__";
    const set = pendingSwaps.get(normalizedMint);
    if (!set) return false;
    return set.has(key);
  },

  /**
   * Provides aggregate counts for heartbeat logging without loading full tables.
   * @param {Object} [options]
   * @param {number} [options.evaluationLookbackMs=300000] - Window for evaluation counts.
   * @returns {Promise<Object>} Snapshot of BootyBox state for logs.
   */
  async getHeartbeatSnapshot(options = {}) {
    const evaluationLookbackMs = Number.isFinite(options.evaluationLookbackMs)
      ? Math.max(0, options.evaluationLookbackMs)
      : 5 * 60 * 1000;

    const coinCountRow = db
      .prepare("SELECT COUNT(*) AS count FROM coins")
      .get();
    const openPositionsRow = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM positions p
      JOIN coins c ON c.mint = p.coin_mint
      WHERE c.status = 'complete'
    `
      )
      .get();

    const exposureRow = db
      .prepare(
        `
      SELECT
        COALESCE(SUM(p.amount * c.price), 0)       AS notionalSol,
        COALESCE(SUM(p.amount * p.entryPrice), 0) AS entrySol
      FROM positions p
      JOIN coins c ON c.mint = p.coin_mint
      WHERE c.status = 'complete'
    `
      )
      .get();

    let recentEvaluationCount = null;
    let recentEvaluationBreakdown = null;
    let recentBuys = null;
    let recentSells = null;
    if (evaluationLookbackMs > 0) {
      const since = Date.now() - evaluationLookbackMs;
      const evalRow = db
        .prepare(
          "SELECT COUNT(*) AS count FROM evaluations WHERE timestamp >= ?"
        )
        .get(since);
      recentEvaluationCount = evalRow?.count || 0;

      const evalBreakdownRows = db
        .prepare(
          `
        SELECT decision, COUNT(*) AS count
        FROM evaluations
        WHERE timestamp >= ?
        GROUP BY decision
      `
        )
        .all(since);

      const breakdown = { pass: 0, fail: 0 };
      for (const row of evalBreakdownRows) {
        const isPass = Number(row.decision) === 1;
        if (isPass) {
          breakdown.pass += Number(row.count) || 0;
        } else {
          breakdown.fail += Number(row.count) || 0;
        }
      }
      recentEvaluationBreakdown = breakdown;

      const buyAggRow = db
        .prepare(
          `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(qty * price), 0)    AS volumeSol,
          COALESCE(SUM(qty * priceUsd), 0) AS volumeUsd,
          COALESCE(SUM(feesUsd), 0)        AS feesUsd
        FROM buys
        WHERE timestamp >= ?
      `
        )
        .get(since);

      const sellAggRow = db
        .prepare(
          `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(qty * price), 0)    AS volumeSol,
          COALESCE(SUM(qty * priceUsd), 0) AS volumeUsd,
          COALESCE(SUM(pnl), 0)            AS realizedPnl,
          COALESCE(SUM(feesUsd), 0)        AS feesUsd
        FROM sells
        WHERE timestamp >= ?
      `
        )
        .get(since);

      recentBuys = {
        count: buyAggRow?.count ? Number(buyAggRow.count) : 0,
        volumeSol: buyAggRow?.volumeSol ? Number(buyAggRow.volumeSol) : 0,
        volumeUsd: buyAggRow?.volumeUsd ? Number(buyAggRow.volumeUsd) : 0,
        feesUsd: buyAggRow?.feesUsd ? Number(buyAggRow.feesUsd) : 0,
      };

      recentSells = {
        count: sellAggRow?.count ? Number(sellAggRow.count) : 0,
        volumeSol: sellAggRow?.volumeSol ? Number(sellAggRow.volumeSol) : 0,
        volumeUsd: sellAggRow?.volumeUsd ? Number(sellAggRow.volumeUsd) : 0,
        realizedPnl: sellAggRow?.realizedPnl
          ? Number(sellAggRow.realizedPnl)
          : 0,
        feesUsd: sellAggRow?.feesUsd ? Number(sellAggRow.feesUsd) : 0,
      };
    }

    const pendingSwapCount = Array.from(pendingSwaps.values()).reduce(
      (total, wallets) => total + wallets.size,
      0
    );
    const pendingSwapMints = Array.from(pendingSwaps.entries()).map(
      ([mint, wallets]) => ({
        mint,
        wallets: Array.from(wallets),
      })
    );

    return {
      coinCount: coinCountRow?.count || 0,
      openPositions: openPositionsRow?.count || 0,
      pendingSwapCount,
      pendingSwapMints,
      recentEvaluationCount,
      evaluationLookbackMs:
        evaluationLookbackMs > 0 ? evaluationLookbackMs : null,
      recentEvaluationBreakdown,
      recentBuys,
      recentSells,
      positionExposure: {
        notionalSol: exposureRow?.notionalSol
          ? Number(exposureRow.notionalSol)
          : 0,
        entryCostSol: exposureRow?.entrySol ? Number(exposureRow.entrySol) : 0,
        unrealizedPnLSol:
          (exposureRow?.notionalSol ? Number(exposureRow.notionalSol) : 0) -
          (exposureRow?.entrySol ? Number(exposureRow.entrySol) : 0),
      },
    };
  },

  /**
   * Bulk upserts positions and removes stale ones in a single transaction.
   * Each item in positions should have:
   *   coin_mint, entryPrice, entryPriceUSD, highestPrice, amount, sl, timestamp, lastValidated
   * Preserves highestPrice by keeping the max of existing vs incoming.
   * @param {Array<Object>} positions
   */
  bulkResyncPositions(positions) {
    const upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO positions
      (coin_mint, trade_uuid, entryPrice, entryPriceUSD, highestPrice, amount, sl, previousRsi, timestamp, lastValidated
      , entryAmt, holdingAmt, walletId, walletAlias,
        entryPriceSol, currentPriceSol, currentPriceUsd,
        highestPriceSol, source, lastUpdated
      )
      VALUES (@coin_mint, @trade_uuid, @entryPrice, @entryPriceUSD, @highestPrice, @amount, @sl, @previousRsi, @timestamp, @lastValidated
      , @entryAmt, @holdingAmt, @walletId, @walletAlias,
        @entryPriceSol, @currentPriceSol, @currentPriceUsd,
        @highestPriceSol, @source, @lastUpdated
      )
    `);
    const selectHighest = db.prepare(
      `SELECT highestPrice, trade_uuid FROM positions WHERE coin_mint = ?`
    );
    const deleteAll = db.prepare(`DELETE FROM positions`);

    const tx = db.transaction((items) => {
      // Upsert/merge highestPrice
      for (const pos of items) {
        const existing = selectHighest.get(pos.coin_mint);
        const currentHighest = existing ? existing.highestPrice ?? 0 : 0;
        let trade_uuid =
          pos.trade_uuid || (existing ? existing.trade_uuid : null) || null;
        if (!trade_uuid) trade_uuid = resolveTradeUuid(pos.coin_mint);
        if (trade_uuid) {
          tradeUuidMap.set(pos.coin_mint, trade_uuid);
          deletePendingTradeUuid(pos.coin_mint);
        }
        const finalHighest = Math.max(
          Number(pos.highestPrice || 0),
          Number(currentHighest || 0)
        );
        // New mapping for extended columns
        const entryAmt = pos.entryAmt ?? pos.amount ?? null;
        const holdingAmt = pos.holdingAmt ?? pos.amount ?? null;
        const walletId = pos.walletId ?? null;
        const walletAlias = pos.walletAlias ?? null;
        const entryPriceSol = pos.entryPriceSol ?? pos.entryPrice ?? null;
        const currentPriceSol = pos.currentPriceSol ?? null;
        const currentPriceUsd = pos.currentPriceUsd ?? null;
        const highestPriceSol = pos.highestPriceSol ?? finalHighest ?? null;
        const source = pos.source ?? null;
        const lastUpdated = Date.now();
        upsertStmt.run({
          ...pos,
          trade_uuid,
          highestPrice: finalHighest,
          previousRsi: pos.previousRsi ?? null,
          entryAmt,
          holdingAmt,
          walletId,
          walletAlias,
          entryPriceSol,
          currentPriceSol,
          currentPriceUsd,
          highestPriceSol,
          source,
          lastUpdated,
        });
      }
      // Remove stale positions not in live set
      if (!items || items.length === 0) {
        deleteAll.run();
      } else {
        const mints = items.map((i) => i.coin_mint);
        const placeholders = mints.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM positions WHERE coin_mint NOT IN (${placeholders})`
        ).run(mints);
      }
    });
    tx(positions || []);
  },

  /**
   * Updates the highest price for a given position.
   * Always pulls the latest highestPrice from the DB before comparing.
   * Logs a warning if the position doesn't exist and a debug message if update is skipped.
   * Returns the updated or current highestPrice.
   * @param {string} mint - The coin mint address.
   * @param {number} price - The new highest price to record.
   * @returns {number|null} The updated or current highest price, or null if position not found.
   */
  updateHighestPrice(mint, price) {
    const position = db
      .prepare(`SELECT highestPrice FROM positions WHERE coin_mint = ?`)
      .get(mint);

    if (!position) {
      logger.warn(
        `[BootyBox] Tried to update highestPrice for unknown mint ${mint}`
      );
      return null;
    }

    const currentHighest = position.highestPrice ?? 0;

    if (price > currentHighest) {
      db.prepare(
        `UPDATE positions SET highestPrice = ?, highestPriceSol = ?, lastUpdated = ? WHERE coin_mint = ?`
      ).run(price, price, Date.now(), mint);
      logger.debug(`[BootyBox] Updated highestPrice for ${mint} → ${price}`);
      return price;
    } else {
      logger.debug(
        `[BootyBox] Skipped highestPrice update for ${mint} — new price ${price} not higher than DB-stored ${currentHighest}`
      );
      return currentHighest;
    }
  },

  /**
   * Retrieves only the highestPrice for a given coin mint from the positions table.
   * @param {string} mint - The coin mint address.
   * @returns {number|null} The highest price or null if the position is not found.
   */
  getHighestPriceByMint(mint) {
    const result = db
      .prepare(`SELECT highestPrice FROM positions WHERE coin_mint = ?`)
      .get(mint);
    return result ? result.highestPrice : null;
  },

  /**
   * Updates the previous RSI value for a given coin in the positions table.
   * Useful for momentum-based exit logic like cliffGuard.
   * @param {string} mint - The coin mint address.
   * @param {number} rsi - The RSI value to store.
   */
  updatePreviousRsi(mint, rsi) {
    db.prepare(`UPDATE positions SET previousRsi = ? WHERE coin_mint = ?`).run(
      rsi,
      mint
    );
    logger.debug(`[BootyBox] Stored previous RSI for ${mint}: ${rsi}`);
  },

  /**
   * Removes coins not updated or evaluated within the last N hours,
   * but preserves coins with open positions or any PnL history.
   * Then resets buyScore on all remaining coins.
   * @param {number} hours – Threshold in hours (default: 2).
   */
  cleanupStaleAndResetBuyScores(hours = 2) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;

    // 1) Delete coins older than cutoff, excluding those in open positions or with PnL records
    db.prepare(
      `
    DELETE FROM coins
    WHERE lastUpdated   < ?
      AND lastEvaluated < ?
      AND mint NOT IN (SELECT coin_mint FROM positions)
      AND mint NOT IN (SELECT coin_mint FROM pnl)
  `
    ).run(cutoff, cutoff);

    // 1a) Delete pools entries where coin_mint no longer exists in coins
    db.prepare(
      `
      DELETE FROM pools
      WHERE coin_mint NOT IN (SELECT mint FROM coins)
    `
    ).run();

    // 2) Reset buyScore on all remaining coins
    db.prepare(
      `
    UPDATE coins
    SET buyScore = 0
  `
    ).run();

    logger.debug(
      `[BootyBox] cleanupStaleAndResetBuyScores: purged stale coins (except open positions & PnL history), reset buyScore`
    );
  },

  updateSessionStats(id, metrics = {}) {
    if (!id) return;
    const sanitizeCount = (value) =>
      Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
    const params = {
      id,
      coinsAnalyzed: sanitizeCount(metrics.coinsAnalyzed),
      coinsPassed: sanitizeCount(metrics.coinsPassed),
      sellsExecuted: sanitizeCount(metrics.sellsExecuted),
    };

    db.prepare(
      `
      UPDATE sessions
      SET
        coinsAnalyzed = CASE WHEN @coinsAnalyzed IS NULL THEN coinsAnalyzed ELSE @coinsAnalyzed END,
        coinsPassed   = CASE WHEN @coinsPassed IS NULL   THEN coinsPassed   ELSE @coinsPassed   END,
        sellsExecuted = CASE WHEN @sellsExecuted IS NULL THEN sellsExecuted ELSE @sellsExecuted END
      WHERE id = @id
    `
    ).run(params);
  },

  startSession(info) {
    const res = db
      .prepare(
        `INSERT INTO sessions (strategy, filterBlueprint, buyBlueprint, sellBlueprint, settings, startTime) VALUES (?,?,?,?,?,?)`
      )
      .run(
        info.strategy,
        info.filterBlueprint,
        info.buyBlueprint,
        info.sellBlueprint,
        JSON.stringify(info.settings || {}),
        Date.now()
      );
    return res.lastInsertRowid;
  },

  endSession(id, metrics = {}) {
    db.prepare(
      `UPDATE sessions SET endTime=?, coinsAnalyzed=?, coinsPassed=?, sellsExecuted=? WHERE id=?`
    ).run(
      Date.now(),
      metrics.coinsAnalyzed || 0,
      metrics.coinsPassed || 0,
      metrics.sellsExecuted || 0,
      id
    );
  },

  getPnLAggregates() {
    const buys = db
      .prepare(
        `
      SELECT
        COALESCE(SUM(priceUsd * qty), 0)   AS totalCostUsd,
        COALESCE(SUM(qty), 0)              AS totalTokens,
        COALESCE(SUM(feesUsd), 0)          AS totalFeesUsd,
        COUNT(*)                           AS count
      FROM buys
    `
      )
      .get();

    const sells = db
      .prepare(
        `
      SELECT
        COALESCE(SUM(pnl), 0)             AS realizedUsd,
        COALESCE(SUM(priceUsd * qty), 0)  AS grossProceedsUsd,
        COALESCE(SUM(feesUsd), 0)         AS totalFeesUsd,
        COUNT(*)                          AS count
      FROM sells
    `
      )
      .get();

    return {
      buys,
      sells,
    };
  },

  async ping() {
    db.prepare("SELECT 1").get();
  },

  async close() {
    if (dbClosed) return;
    db.close();
    dbClosed = true;
  },

  setTradeUuid,
  getTradeUuid,
  clearTradeUuid,
};

BootyBox.init = async (options = {}) => {
  defaultWalletPublicKey =
    options.publicKey || options.wallet || options.defaultWallet || null;
  setDefaultWalletPublicKey(defaultWalletPublicKey);
  logger.debug("[BootyBox] SQLite database ready");
};

BootyBox.engine = "sqlite";

module.exports = BootyBox;
