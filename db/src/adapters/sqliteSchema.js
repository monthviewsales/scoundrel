function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureSqliteSchema(db, tradeUuidMap) {
db.exec(`
  CREATE TABLE IF NOT EXISTS coins (
    mint             TEXT PRIMARY KEY,
    symbol           TEXT,
    name             TEXT,
    decimals         INTEGER,
    image            TEXT,
    uri              TEXT,
    marketCap        REAL,
    status           TEXT CHECK(status IN ('incomplete','complete','failed','blacklist')),
    lastUpdated      INTEGER,
    lastEvaluated    INTEGER DEFAULT 0,
    price            REAL,        -- SOL price per token (legacy)
    liquidity        REAL,        -- SOL liquidity (legacy)
    buyScore         REAL,
    priceSol         REAL,        -- SOL price per token
    priceUsd         REAL,        -- USD price per token
    liquiditySol     REAL,        -- SOL liquidity
    liquidityUsd     REAL,        -- USD liquidity
    marketCapSol     REAL,        -- market cap in SOL
    marketCapUsd     REAL,        -- market cap in USD (canonical)
    tokenCreatedAt   INTEGER,     -- on-chain token creation time (ms)
    firstSeenAt      INTEGER,     -- when BootyBox first saw this coin (ms)
    strictSocials    TEXT         -- JSON string of strictSocials
  );

  CREATE TABLE IF NOT EXISTS positions (
    coin_mint        TEXT PRIMARY KEY,
    trade_uuid       TEXT,
    entryPrice       REAL,        -- SOL per token (legacy)
    entryPriceUSD    REAL,        -- USD per token
    highestPrice     REAL,        -- SOL per token (legacy)
    amount           REAL,
    sl               REAL,        -- stop-loss percentage (legacy)
    previousRsi      REAL,
    timestamp        INTEGER,
    lastValidated    INTEGER,
    entryAmt         REAL,        -- tokens at entry
    holdingAmt       REAL,        -- current tokens held
    walletId         INTEGER,     -- FK to sc_wallets.wallet_id
    walletAlias      TEXT,        -- denormalized alias
    entryPriceSol    REAL,        -- canonical SOL entry price
    currentPriceSol  REAL,        -- latest SOL price
    currentPriceUsd  REAL,        -- latest USD price
    highestPriceSol  REAL,        -- canonical SOL high watermark
    source           TEXT,        -- bot/human origin tag
    lastUpdated      INTEGER      -- last refresh timestamp (ms)
  );

  CREATE TABLE IF NOT EXISTS buys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_mint       TEXT,
    trade_uuid      TEXT,
    price           REAL,        -- SOL/token at buy
    priceUsd        REAL,        -- USD/token at buy
    qty             REAL,
    timestamp       INTEGER,
    txid            TEXT UNIQUE,
    fees            INTEGER,     -- lamports
    feesUsd         REAL,        -- USD fees
    solUsdPrice     REAL,
    slippage        REAL,
    priceImpact     REAL,
    hiddenTax       REAL,
    executionPrice  REAL,
    currentPrice    REAL
  );

  CREATE TABLE IF NOT EXISTS sells (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_mint       TEXT,
    trade_uuid      TEXT,
    price           REAL,        -- SOL/token at sell
    priceUsd        REAL,        -- USD/token at sell
    qty             REAL,
    timestamp       INTEGER,
    txid            TEXT UNIQUE,
    pnl             REAL,        -- USD realized
    pnlPct          REAL,
    fees            INTEGER,     -- lamports
    feesUsd         REAL,        -- USD fees
    solUsdPrice     REAL,
    slippage        REAL,
    priceImpact     REAL,
    hiddenTax       REAL,
    executionPrice  REAL,
    currentPrice    REAL
  );

  CREATE TABLE IF NOT EXISTS pools (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_mint        TEXT,
    liquidity_quote  REAL,
    liquidity_usd    REAL,
    price_quote      REAL,
    price_usd        REAL,
    tokenSupply      REAL,
    lpBurn           INTEGER,
    marketCap_quote  REAL,
    marketCap_usd    REAL,
    market           TEXT,
    quoteToken       TEXT,
    createdAt        INTEGER,
    lastUpdated      INTEGER,
    txns_buys        INTEGER,
    txns_sells       INTEGER,
    txns_total       INTEGER,
    volume_quote     REAL,
    volume24h_quote  REAL,
    deployer         TEXT,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint),
    UNIQUE(coin_mint, market)
  );

  CREATE TABLE IF NOT EXISTS events (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_mint                 TEXT,
    interval                  TEXT,
    insertedAt                INTEGER,   -- first time we recorded this interval for this coin
    previousUpdatedAt         INTEGER,   -- previous update timestamp
    updatedAt                 INTEGER,   -- latest update timestamp
    priceChangePercentage     REAL,
    priceChangePercentageDelta REAL,
    volumeSol                 REAL,
    volumeSolDelta            REAL,
    volumeUsd                 REAL,
    volumeUsdDelta            REAL,
    buysCount                 INTEGER,
    buysCountDelta            INTEGER,
    sellsCount                INTEGER,
    sellsCountDelta           INTEGER,
    txnsCount                 INTEGER,
    txnsCountDelta            INTEGER,
    holdersCount              INTEGER,
    holdersCountDelta         INTEGER,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint)
  );

  CREATE TABLE IF NOT EXISTS risk (
    coin_mint                 TEXT PRIMARY KEY,
    rugged                    BOOLEAN,
    riskScore                 INTEGER,
    insertedAt                INTEGER,   -- first time we recorded risk for this coin
    previousUpdatedAt         INTEGER,   -- previous update timestamp
    updatedAt                 INTEGER,   -- latest update timestamp
    snipersCount              INTEGER,
    snipersTotalBalance       REAL,
    snipersTotalPercent       REAL,
    snipersCountDelta         INTEGER,
    snipersTotalBalanceDelta  REAL,
    snipersTotalPercentDelta  REAL,
    insidersCount             INTEGER,
    insidersTotalBalance      REAL,
    insidersTotalPercent      REAL,
    insidersCountDelta        INTEGER,
    insidersTotalBalanceDelta REAL,
    insidersTotalPercentDelta REAL,
    top10Percent              REAL,
    top10PercentDelta         REAL,
    devPercent                REAL,
    devPercentDelta           REAL,
    devAmountTokens           REAL,
    devAmountTokensDelta      REAL,
    feesTotalSol              REAL,
    feesTotalSolDelta         REAL,
    riskScoreDelta            REAL,
    risksJson                 TEXT,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint)
  );

  CREATE TABLE IF NOT EXISTS chart_data (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_mint  TEXT,
    timestamp  INTEGER,
    open       REAL,
    close      REAL,
    low        REAL,
    high       REAL,
    volume     REAL,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint)
  );

  CREATE TABLE IF NOT EXISTS indicators (
    coin_mint  TEXT PRIMARY KEY,
    price      REAL,
    rsi        REAL,
    emaShort   REAL,
    emaMedium  REAL,
    bb_middle  REAL,
    bb_upper   REAL,
    bb_lower   REAL,
    bb_pb      REAL,
    trendBias  BOOLEAN,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint)
  );

  CREATE TABLE IF NOT EXISTS pnl (
    coin_mint           TEXT PRIMARY KEY,
    holding             REAL    DEFAULT 0,
    held                REAL    DEFAULT 0,
    sold                REAL    DEFAULT 0,
    sold_usd            REAL    DEFAULT 0,
    realized            REAL    DEFAULT 0,
    unrealized          REAL    DEFAULT 0,
    fees_sol            REAL    DEFAULT 0,
    fees_usd            REAL    DEFAULT 0,
    total               REAL    DEFAULT 0,
    total_sold          REAL    DEFAULT 0,
    total_invested      REAL    DEFAULT 0,
    average_buy_amount  REAL    DEFAULT 0,
    current_value       REAL    DEFAULT 0,
    cost_basis          REAL    DEFAULT 0,
    first_trade_time    INTEGER,
    last_buy_time       INTEGER,
    last_sell_time      INTEGER,
    last_trade_time     INTEGER,
    buy_transactions    INTEGER DEFAULT 0,
    sell_transactions   INTEGER DEFAULT 0,
    total_transactions  INTEGER DEFAULT 0,
    lastUpdated         INTEGER,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint)
  );

  CREATE TABLE IF NOT EXISTS trades (
    trade_uuid  TEXT,
    tx          TEXT PRIMARY KEY,
    mint        TEXT,
    wallet      TEXT,
    amount      REAL,
    priceUsd    REAL,
    volume      REAL,
    volumeSol   REAL,
    type        TEXT,
    time        INTEGER,
    program     TEXT,
    pools       TEXT
  );

  -- Unified trade events table for Scoundrel HUD / Warchest
  CREATE TABLE IF NOT EXISTS sc_trades (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_uuid            TEXT,
    wallet_id             INTEGER,
    wallet_alias          TEXT,
    coin_mint             TEXT NOT NULL,
    txid                  TEXT NOT NULL,
    side                  TEXT NOT NULL CHECK(side IN ('buy','sell')),
    executed_at           INTEGER,
    token_amount          REAL,
    sol_amount            REAL,
    strategy_id           TEXT,
    strategy_name         TEXT,
    price_sol_per_token   REAL,
    price_usd_per_token   REAL,
    sol_usd_price         REAL,
    fees_sol              REAL,
    fees_usd              REAL,
    slippage_pct          REAL,
    price_impact_pct      REAL,
    program               TEXT,
    evaluation_payload    TEXT,
    decision_payload      TEXT,
    decision_label        TEXT,
    decision_reason       TEXT,
    UNIQUE(txid)
  );

  -- Active position snapshot per wallet + mint
  CREATE TABLE IF NOT EXISTS sc_positions (
    position_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id             INTEGER NOT NULL,
    wallet_alias          TEXT,
    coin_mint             TEXT NOT NULL,
    trade_uuid            TEXT,
    strategy_id           TEXT,
    strategy_name         TEXT,
    open_at               INTEGER,
    closed_at             INTEGER,
    last_trade_at         INTEGER,
    last_updated_at       INTEGER,
    entry_token_amount    REAL,
    current_token_amount  REAL,
    total_tokens_bought   REAL,
    total_tokens_sold     REAL,
    entry_price_sol       REAL,
    entry_price_usd       REAL,
    last_price_sol        REAL,
    last_price_usd        REAL,
    source                TEXT,
    UNIQUE(wallet_id, coin_mint, trade_uuid)
  );

  CREATE TABLE IF NOT EXISTS pending_trade_uuids (
    mint        TEXT PRIMARY KEY,
    trade_uuid  TEXT,
    created_at  INTEGER
  );

  -- Catalog of encountered markets (deduped)
  CREATE TABLE IF NOT EXISTS markets (
    name       TEXT PRIMARY KEY,
    firstSeen  INTEGER,
    lastSeen   INTEGER,
    seenCount  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy TEXT,
    filterBlueprint TEXT,
    buyBlueprint TEXT,
    sellBlueprint TEXT,
    settings TEXT,
    startTime INTEGER,
    endTime INTEGER,
    coinsAnalyzed INTEGER,
    coinsPassed INTEGER,
    sellsExecuted INTEGER
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    eval_id TEXT PRIMARY KEY,
    timestamp INTEGER,
    tokenSymbol TEXT,
    mint TEXT,
    strategy TEXT,
    evalType TEXT,
    decision INTEGER,
    reason TEXT,
    blueprintCatalog TEXT,
    blueprintActive TEXT,
    gateResults TEXT
  );

  CREATE TABLE IF NOT EXISTS sc_wallets (
    wallet_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    alias                TEXT NOT NULL UNIQUE,
    pubkey               TEXT NOT NULL,
    usage_type           TEXT NOT NULL DEFAULT 'other',              -- 'funding','strategy','kol','deployer','other'
    is_default_funding   INTEGER NOT NULL DEFAULT 0,
    auto_attach_warchest INTEGER NOT NULL DEFAULT 0,
    strategy_id          TEXT NULL,
    color                TEXT NULL,
    has_private_key      INTEGER NOT NULL DEFAULT 0,
    key_source           TEXT NOT NULL DEFAULT 'none',               -- 'none','keychain','db_encrypted'
    key_ref              TEXT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sc_profiles (
    profile_id  TEXT PRIMARY KEY,
    name        TEXT,
    wallet      TEXT NOT NULL,
    profile     TEXT,
    source      TEXT,
    created_at  INTEGER,
    updated_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS sc_wallet_analyses (
    analysis_id   TEXT PRIMARY KEY,
    wallet        TEXT NOT NULL,
    trader_name   TEXT,
    trade_count   INTEGER DEFAULT 0,
    chart_count   INTEGER DEFAULT 0,
    json_version  TEXT,
    merged        TEXT,
    response_raw  TEXT,
    created_at    INTEGER,
    updated_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS sc_trade_autopsies (
    autopsy_id    TEXT PRIMARY KEY,
    wallet        TEXT NOT NULL,
    mint          TEXT NOT NULL,
    symbol        TEXT,
    json_version  TEXT,
    payload       TEXT,
    response_raw  TEXT,
    created_at    INTEGER,
    updated_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS sc_asks (
    ask_id         TEXT PRIMARY KEY,
    correlation_id TEXT,
    question       TEXT NOT NULL,
    profile        TEXT,
    rows           TEXT,
    model          TEXT,
    temperature    REAL,
    response_raw   TEXT,
    answer         TEXT,
    bullets        TEXT,
    actions        TEXT,
    created_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS sc_tunes (
    tune_id         TEXT PRIMARY KEY,
    correlation_id  TEXT,
    profile         TEXT,
    current_settings TEXT,
    model           TEXT,
    temperature     REAL,
    response_raw    TEXT,
    answer          TEXT,
    bullets         TEXT,
    actions         TEXT,
    changes         TEXT,
    patch           TEXT,
    risks           TEXT,
    rationale       TEXT,
    created_at      INTEGER
  );

  CREATE TABLE IF NOT EXISTS sc_job_runs (
    job_run_id   TEXT PRIMARY KEY,
    job          TEXT NOT NULL,
    context      TEXT,
    input        TEXT,
    response_raw TEXT,
    created_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS sc_wallet_profiles (
    wallet          TEXT PRIMARY KEY,
    version         INTEGER,
    technique_json  TEXT,
    outcomes_json   TEXT,
    heuristics_json TEXT,
    enrichment_json TEXT,
    updated_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS sc_wallet_profile_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet          TEXT,
    version         INTEGER,
    technique_json  TEXT,
    outcomes_json   TEXT,
    heuristics_json TEXT,
    enrichment_json TEXT,
    created_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS sc_wallet_profile_index (
    wallet          TEXT PRIMARY KEY,
    style           TEXT,
    entry_technique TEXT,
    win_rate        REAL,
    median_exit_pct REAL,
    median_hold_mins REAL,
    last_seen_at    TEXT
  );

  -- Helpful indexes for frequent lookups/cleanup
  CREATE INDEX IF NOT EXISTS idx_coins_status ON coins(status);
  CREATE INDEX IF NOT EXISTS idx_coins_lastUpdated ON coins(lastUpdated);
  CREATE INDEX IF NOT EXISTS idx_positions_lastValidated ON positions(lastValidated);
  CREATE INDEX IF NOT EXISTS idx_pools_coin_mint ON pools(coin_mint);
  CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
  CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet);
  CREATE INDEX IF NOT EXISTS idx_coins_buyScore ON coins(buyScore);
  CREATE INDEX IF NOT EXISTS idx_coins_status_buy_lastUpdated
    ON coins(status, buyScore, lastUpdated);

  CREATE INDEX IF NOT EXISTS idx_sc_trades_wallet_mint
    ON sc_trades (wallet_id, coin_mint);

  CREATE INDEX IF NOT EXISTS idx_sc_trades_executed_at
    ON sc_trades (executed_at);

  CREATE INDEX IF NOT EXISTS idx_sc_trades_strategy
    ON sc_trades (strategy_id);

  CREATE INDEX IF NOT EXISTS idx_sc_positions_wallet_mint
    ON sc_positions (wallet_id, coin_mint);

  CREATE INDEX IF NOT EXISTS idx_sc_positions_open_at
    ON sc_positions (open_at);

  CREATE INDEX IF NOT EXISTS idx_sc_wallet_analyses_wallet
    ON sc_wallet_analyses (wallet);

  CREATE INDEX IF NOT EXISTS idx_sc_trade_autopsies_wallet
    ON sc_trade_autopsies (wallet);

  CREATE INDEX IF NOT EXISTS idx_sc_trade_autopsies_mint
    ON sc_trade_autopsies (mint);
`);


ensureColumn(db, "pools", "txns_buys", "INTEGER");
ensureColumn(db, "pools", "txns_sells", "INTEGER");
ensureColumn(db, "pools", "txns_total", "INTEGER");
ensureColumn(db, "pools", "volume_quote", "REAL");
ensureColumn(db, "pools", "volume24h_quote", "REAL");
ensureColumn(db, "pools", "deployer", "TEXT");
ensureColumn(db, "coins", "priceSol", "REAL");
ensureColumn(db, "coins", "priceUsd", "REAL");
ensureColumn(db, "coins", "liquiditySol", "REAL");
ensureColumn(db, "coins", "liquidityUsd", "REAL");
ensureColumn(db, "coins", "marketCapSol", "REAL");
ensureColumn(db, "coins", "marketCapUsd", "REAL");
ensureColumn(db, "coins", "tokenCreatedAt", "INTEGER");
ensureColumn(db, "coins", "firstSeenAt", "INTEGER");
ensureColumn(db, "coins", "strictSocials", "TEXT");

ensureColumn(db, "events", "insertedAt", "INTEGER");
ensureColumn(db, "events", "previousUpdatedAt", "INTEGER");
ensureColumn(db, "events", "updatedAt", "INTEGER");
ensureColumn(db, "events", "priceChangePercentageDelta", "REAL");
ensureColumn(db, "events", "volumeSol", "REAL");
ensureColumn(db, "events", "volumeSolDelta", "REAL");
ensureColumn(db, "events", "volumeUsd", "REAL");
ensureColumn(db, "events", "volumeUsdDelta", "REAL");
ensureColumn(db, "events", "buysCount", "INTEGER");
ensureColumn(db, "events", "buysCountDelta", "INTEGER");
ensureColumn(db, "events", "sellsCount", "INTEGER");
ensureColumn(db, "events", "sellsCountDelta", "INTEGER");
ensureColumn(db, "events", "txnsCount", "INTEGER");
ensureColumn(db, "events", "txnsCountDelta", "INTEGER");
ensureColumn(db, "events", "holdersCount", "INTEGER");
ensureColumn(db, "events", "holdersCountDelta", "INTEGER");

ensureColumn(db, "risk", "insertedAt", "INTEGER");
ensureColumn(db, "risk", "previousUpdatedAt", "INTEGER");
ensureColumn(db, "risk", "updatedAt", "INTEGER");
ensureColumn(db, "risk", "snipersCount", "INTEGER");
ensureColumn(db, "risk", "snipersTotalBalance", "REAL");
ensureColumn(db, "risk", "snipersTotalPercent", "REAL");
ensureColumn(db, "risk", "snipersCountDelta", "INTEGER");
ensureColumn(db, "risk", "snipersTotalBalanceDelta", "REAL");
ensureColumn(db, "risk", "snipersTotalPercentDelta", "REAL");
ensureColumn(db, "risk", "insidersCount", "INTEGER");
ensureColumn(db, "risk", "insidersTotalBalance", "REAL");
ensureColumn(db, "risk", "insidersTotalPercent", "REAL");
ensureColumn(db, "risk", "insidersCountDelta", "INTEGER");
ensureColumn(db, "risk", "insidersTotalBalanceDelta", "REAL");
ensureColumn(db, "risk", "insidersTotalPercentDelta", "REAL");
ensureColumn(db, "risk", "top10Percent", "REAL");
ensureColumn(db, "risk", "top10PercentDelta", "REAL");
ensureColumn(db, "risk", "devPercent", "REAL");
ensureColumn(db, "risk", "devPercentDelta", "REAL");
ensureColumn(db, "risk", "devAmountTokens", "REAL");
ensureColumn(db, "risk", "devAmountTokensDelta", "REAL");
ensureColumn(db, "risk", "feesTotalSol", "REAL");
ensureColumn(db, "risk", "feesTotalSolDelta", "REAL");
ensureColumn(db, "risk", "riskScoreDelta", "REAL");
ensureColumn(db, "risk", "risksJson", "TEXT");

ensureColumn(db, "positions", "trade_uuid", "TEXT");
ensureColumn(db, "positions", "entryAmt", "REAL");
ensureColumn(db, "positions", "holdingAmt", "REAL");
ensureColumn(db, "positions", "walletId", "INTEGER");
ensureColumn(db, "positions", "walletAlias", "TEXT");
ensureColumn(db, "positions", "entryPriceSol", "REAL");
ensureColumn(db, "positions", "currentPriceSol", "REAL");
ensureColumn(db, "positions", "currentPriceUsd", "REAL");
ensureColumn(db, "positions", "highestPriceSol", "REAL");
ensureColumn(db, "positions", "source", "TEXT");
ensureColumn(db, "positions", "lastUpdated", "INTEGER");
ensureColumn(db, "buys", "trade_uuid", "TEXT");
ensureColumn(db, "buys", "solUsdPrice", "REAL");
ensureColumn(db, "buys", "slippage", "REAL");
ensureColumn(db, "buys", "priceImpact", "REAL");
ensureColumn(db, "buys", "hiddenTax", "REAL");
ensureColumn(db, "buys", "executionPrice", "REAL");
ensureColumn(db, "buys", "currentPrice", "REAL");
ensureColumn(db, "sells", "trade_uuid", "TEXT");
ensureColumn(db, "sells", "solUsdPrice", "REAL");
ensureColumn(db, "sells", "slippage", "REAL");
ensureColumn(db, "sells", "priceImpact", "REAL");
ensureColumn(db, "sells", "hiddenTax", "REAL");
ensureColumn(db, "sells", "executionPrice", "REAL");
ensureColumn(db, "sells", "currentPrice", "REAL");
ensureColumn(db, "indicators", "emaShort", "REAL");
ensureColumn(db, "indicators", "emaMedium", "REAL");
ensureColumn(db, "indicators", "macd", "REAL");
ensureColumn(db, "trades", "trade_uuid", "TEXT");
ensureColumn(db, "evaluations", "blueprintCatalog", "TEXT");
ensureColumn(db, "evaluations", "blueprintActive", "TEXT");
ensureColumn(db, "evaluations", "gateResults", "TEXT");
ensureColumn(db, "sc_wallets", "usage_type", "TEXT NOT NULL DEFAULT 'other'");
ensureColumn(db, "sc_wallets", "is_default_funding", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "sc_wallets", "auto_attach_warchest", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "sc_wallets", "strategy_id", "TEXT");
ensureColumn(db, "sc_trades", "created_at", "INTEGER");
ensureColumn(db, "sc_trades", "updated_at", "INTEGER");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sc_wallets_usage_type
    ON sc_wallets (usage_type);

  CREATE INDEX IF NOT EXISTS idx_sc_wallets_default_funding
    ON sc_wallets (is_default_funding);

  CREATE INDEX IF NOT EXISTS idx_sc_wallets_auto_attach
    ON sc_wallets (auto_attach_warchest);
`);

const uuidRows = db
  .prepare(
    "SELECT coin_mint, trade_uuid FROM positions WHERE trade_uuid IS NOT NULL"
  )
  .all();
for (const row of uuidRows) {
  tradeUuidMap.set(row.coin_mint, row.trade_uuid);
}
const pendingUuidRows = db
  .prepare(
    "SELECT mint, trade_uuid FROM pending_trade_uuids WHERE trade_uuid IS NOT NULL"
  )
  .all();
for (const row of pendingUuidRows) {
  if (!tradeUuidMap.has(row.mint)) {
    tradeUuidMap.set(row.mint, row.trade_uuid);
  }
}
}

module.exports = { ensureSqliteSchema };
