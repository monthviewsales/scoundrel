-- SQLite schema bootstrap generated from adapter definitions

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
    price            REAL,
    liquidity        REAL,
    buyScore         REAL
  );

CREATE TABLE IF NOT EXISTS positions (
    coin_mint       TEXT PRIMARY KEY,
    trade_uuid      TEXT,
    entryPrice      REAL,        -- SOL per token
    entryPriceUSD   REAL,        -- USD per token
    highestPrice    REAL,
    amount          REAL,
    sl              REAL,
    previousRsi     REAL,
    timestamp       INTEGER,
    lastValidated   INTEGER
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
    FOREIGN KEY (coin_mint) REFERENCES coins(mint),
    UNIQUE(coin_mint, market)
  );

CREATE TABLE IF NOT EXISTS events (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_mint             TEXT,
    interval              TEXT,
    priceChangePercentage REAL,
    FOREIGN KEY (coin_mint) REFERENCES coins(mint)
  );

CREATE TABLE IF NOT EXISTS risk (
    coin_mint TEXT PRIMARY KEY,
    rugged    BOOLEAN,
    riskScore INTEGER,
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

CREATE TABLE IF NOT EXISTS pending_trade_uuids (
    mint        TEXT PRIMARY KEY,
    trade_uuid  TEXT,
    created_at  INTEGER
  );

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
    wallet_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    alias           TEXT UNIQUE,
    pubkey          TEXT NOT NULL,
    color           TEXT,
    has_private_key INTEGER DEFAULT 0,
    key_source      TEXT,
    key_ref         TEXT,
    created_at      INTEGER,
    updated_at      INTEGER
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

CREATE INDEX IF NOT EXISTS idx_coins_status ON coins(status);

CREATE INDEX IF NOT EXISTS idx_coins_lastUpdated ON coins(lastUpdated);

CREATE INDEX IF NOT EXISTS idx_positions_lastValidated ON positions(lastValidated);

CREATE INDEX IF NOT EXISTS idx_pools_coin_mint ON pools(coin_mint);

CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);

CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet);
