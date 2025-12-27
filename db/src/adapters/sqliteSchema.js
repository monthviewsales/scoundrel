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

  CREATE TABLE pools (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address     TEXT,                      -- NEW
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
    UNIQUE(coin_mint, pool_address)             -- UPDATED
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
    session_id            INTEGER,
    created_at            INTEGER,
    updated_at            INTEGER,
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
    closed_at INTEGER NOT NULL DEFAULT 0,
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

  -- Pending position-run UUIDs for cases where sc_positions is not created yet (e.g. out-of-order writes)
  CREATE TABLE IF NOT EXISTS pending_trade_uuids (
    wallet_id    INTEGER,          -- nullable for back-compat / unknown wallet context
    mint         TEXT NOT NULL,
    trade_uuid   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE(wallet_id, mint)
  );

  CREATE TABLE IF NOT EXISTS sc_sessions (
    session_id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- service-level identity
    service                 TEXT NOT NULL,          -- e.g. 'warchest-service'
    service_instance_id     TEXT NOT NULL,          -- UUID per process start

    -- lifecycle anchors
    started_at              INTEGER NOT NULL,       -- ms epoch
    start_slot              INTEGER NOT NULL,
    start_block_time        INTEGER,

    ended_at                INTEGER,                -- ms epoch
    end_slot                INTEGER,
    end_block_time          INTEGER,
    end_reason              TEXT,                   -- 'clean' | 'crash' | 'restart'

    -- explicit refresh / heartbeat (called by Warchest service)
    last_refresh_at         INTEGER,
    last_refresh_slot       INTEGER,
    last_refresh_block_time INTEGER,

    -- session rollups (updated by updateSessionStats)
    trades_count            INTEGER DEFAULT 0,
    fees_usd                REAL    DEFAULT 0,
    buys_usd                REAL    DEFAULT 0,
    sells_usd               REAL    DEFAULT 0,

    created_at              INTEGER,
    updated_at              INTEGER,
    meta_json               TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_sc_sessions_one_open
    ON sc_sessions(service)
    WHERE ended_at IS NULL;

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

  CREATE TABLE IF NOT EXISTS sc_pnl (
  wallet_id            INTEGER NOT NULL,
  wallet_alias         TEXT,
  coin_mint            TEXT NOT NULL,
  total_tokens_bought  REAL    DEFAULT 0,
  total_tokens_sold    REAL    DEFAULT 0,
  total_sol_spent      REAL    DEFAULT 0,
  total_sol_received   REAL    DEFAULT 0,
  fees_sol             REAL    DEFAULT 0,
  fees_usd             REAL    DEFAULT 0,
  avg_cost_sol         REAL    DEFAULT 0,        -- weighted avg cost per token (SOL)
  avg_cost_usd         REAL    DEFAULT 0,        -- weighted avg cost per token (USD)
  realized_sol         REAL    DEFAULT 0,
  realized_usd         REAL    DEFAULT 0,
  first_trade_at       INTEGER,
  last_trade_at        INTEGER,
  last_updated_at      INTEGER,
  PRIMARY KEY (wallet_id, coin_mint)
);

  -- Aggregated PnL totals per wallet + mint + trade_uuid (position-run rollups)
  CREATE TABLE IF NOT EXISTS sc_pnl_positions (
    wallet_id            INTEGER NOT NULL,
    wallet_alias         TEXT,
    coin_mint            TEXT NOT NULL,
    trade_uuid           TEXT NOT NULL,            -- position-run identifier (first buy -> last sell)
    total_tokens_bought  REAL    DEFAULT 0,
    total_tokens_sold    REAL    DEFAULT 0,
    total_sol_spent      REAL    DEFAULT 0,
    total_sol_received   REAL    DEFAULT 0,
    fees_sol             REAL    DEFAULT 0,
    fees_usd             REAL    DEFAULT 0,
    avg_cost_sol         REAL    DEFAULT 0,
    avg_cost_usd         REAL    DEFAULT 0,
    realized_sol         REAL    DEFAULT 0,
    realized_usd         REAL    DEFAULT 0,
    first_trade_at       INTEGER,
    last_trade_at        INTEGER,
    last_updated_at      INTEGER,
    PRIMARY KEY (wallet_id, coin_mint, trade_uuid)
  );

  CREATE VIEW IF NOT EXISTS sc_pnl_live AS
    SELECT
      p.wallet_id,
      COALESCE(p.wallet_alias, pn.wallet_alias) AS wallet_alias,
      p.coin_mint,
      pn.total_tokens_bought,
      pn.total_tokens_sold,
      pn.total_sol_spent,
      pn.total_sol_received,
      pn.fees_sol,
      pn.fees_usd,
      pn.avg_cost_sol,
      pn.avg_cost_usd,
      pn.realized_sol,
      pn.realized_usd,
      p.current_token_amount,
      c.priceSol AS coin_price_sol,
      c.priceUsd AS coin_price_usd,
      (p.current_token_amount * c.priceSol) AS unrealized_sol,
      (p.current_token_amount * c.priceUsd) AS unrealized_usd,
      (pn.realized_sol + (p.current_token_amount * c.priceSol)) AS total_sol,
      (pn.realized_usd + (p.current_token_amount * c.priceUsd)) AS total_usd,
      pn.first_trade_at,
      pn.last_trade_at,
      pn.last_updated_at
    FROM sc_positions p
    LEFT JOIN sc_pnl pn
      ON pn.wallet_id = p.wallet_id AND pn.coin_mint = p.coin_mint
    LEFT JOIN coins c
      ON c.mint = p.coin_mint;

  CREATE VIEW IF NOT EXISTS sc_pnl_positions_live AS
    SELECT
      p.wallet_id,
      COALESCE(p.wallet_alias, pn.wallet_alias) AS wallet_alias,
      p.coin_mint,
      p.trade_uuid,

      COALESCE(pn.total_tokens_bought, 0) AS total_tokens_bought,
      COALESCE(pn.total_tokens_sold, 0) AS total_tokens_sold,
      COALESCE(pn.total_sol_spent, 0) AS total_sol_spent,
      COALESCE(pn.total_sol_received, 0) AS total_sol_received,
      COALESCE(pn.fees_sol, 0) AS fees_sol,
      COALESCE(pn.fees_usd, 0) AS fees_usd,
      COALESCE(pn.avg_cost_sol, 0) AS avg_cost_sol,
      COALESCE(pn.avg_cost_usd, 0) AS avg_cost_usd,
      COALESCE(pn.realized_sol, 0) AS realized_sol,
      COALESCE(pn.realized_usd, 0) AS realized_usd,

      -- Wallet-balance derived amount (what you actually hold right now)
      p.current_token_amount,

      -- Trade-derived position size (bought - sold) used for PnL math
      (COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) AS position_token_amount,

      c.priceSol AS coin_price_sol,
      c.priceUsd AS coin_price_usd,

      -- Unrealized PnL (NOT position value)
      (
        ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * COALESCE(c.priceSol, 0))
        - ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * ABS(COALESCE(pn.avg_cost_sol, 0)))
      ) AS unrealized_sol,
      (
        ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * COALESCE(c.priceUsd, 0))
        - ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * ABS(COALESCE(pn.avg_cost_usd, 0)))
      ) AS unrealized_usd,

      -- Total PnL (realized + unrealized)
      (
        COALESCE(pn.realized_sol, 0) + (
          ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * COALESCE(c.priceSol, 0))
          - ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * ABS(COALESCE(pn.avg_cost_sol, 0)))
        )
      ) AS total_sol,
      (
        COALESCE(pn.realized_usd, 0) + (
          ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * COALESCE(c.priceUsd, 0))
          - ((COALESCE(pn.total_tokens_bought, 0) - COALESCE(pn.total_tokens_sold, 0)) * ABS(COALESCE(pn.avg_cost_usd, 0)))
        )
      ) AS total_usd,

      pn.first_trade_at,
      pn.last_trade_at,
      pn.last_updated_at
    FROM sc_positions p
    LEFT JOIN sc_pnl_positions pn
      ON pn.wallet_id = p.wallet_id AND pn.coin_mint = p.coin_mint AND pn.trade_uuid = p.trade_uuid
    LEFT JOIN coins c
      ON c.mint = p.coin_mint
    WHERE p.trade_uuid IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS trg_sc_pnl_buy
  AFTER INSERT ON sc_trades
  WHEN NEW.side = 'buy'
  BEGIN
    INSERT INTO sc_pnl (
      wallet_id, wallet_alias, coin_mint,
      total_tokens_bought, total_sol_spent,
      fees_sol, fees_usd,
      avg_cost_sol, avg_cost_usd,
      realized_sol, realized_usd,
      first_trade_at, last_trade_at, last_updated_at
    ) VALUES (
      NEW.wallet_id, NEW.wallet_alias, NEW.coin_mint,
      COALESCE(NEW.token_amount, 0), COALESCE(NEW.sol_amount, 0),
      COALESCE(NEW.fees_sol, 0), COALESCE(NEW.fees_usd, 0),
      CASE WHEN COALESCE(NEW.token_amount, 0) > 0 THEN ABS(COALESCE(NEW.sol_amount, 0)) / NEW.token_amount ELSE 0 END,
      CASE WHEN COALESCE(NEW.token_amount, 0) > 0 THEN (ABS(COALESCE(NEW.sol_amount, 0)) / NEW.token_amount) * COALESCE(NEW.sol_usd_price, 0) ELSE 0 END,
      0, 0,
      NEW.executed_at, NEW.executed_at, NEW.executed_at
    )
    ON CONFLICT(wallet_id, coin_mint) DO UPDATE SET
      wallet_alias        = COALESCE(excluded.wallet_alias, sc_pnl.wallet_alias),
      total_tokens_bought = sc_pnl.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0),
      total_sol_spent     = sc_pnl.total_sol_spent + COALESCE(excluded.total_sol_spent, 0),
      fees_sol            = sc_pnl.fees_sol + COALESCE(excluded.fees_sol, 0),
      fees_usd            = sc_pnl.fees_usd + COALESCE(excluded.fees_usd, 0),
      avg_cost_sol        = CASE
                              WHEN (sc_pnl.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0)) > 0
                              THEN ABS(sc_pnl.total_sol_spent + COALESCE(excluded.total_sol_spent, 0))
                                  / (sc_pnl.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0))
                              ELSE sc_pnl.avg_cost_sol
                            END,
      avg_cost_usd        = CASE
                              WHEN (sc_pnl.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0)) > 0
                              THEN (ABS(sc_pnl.total_sol_spent + COALESCE(excluded.total_sol_spent, 0)) * COALESCE(NEW.sol_usd_price, 0))
                                  / (sc_pnl.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0))
                              ELSE sc_pnl.avg_cost_usd
                            END,
      first_trade_at      = COALESCE(sc_pnl.first_trade_at, excluded.first_trade_at),
      last_trade_at       = MAX(sc_pnl.last_trade_at, excluded.last_trade_at),
      last_updated_at     = excluded.last_updated_at;

    -- Position-run rollup (only when a trade_uuid is present)
    INSERT INTO sc_pnl_positions (
      wallet_id, wallet_alias, coin_mint, trade_uuid,
      total_tokens_bought, total_sol_spent,
      fees_sol, fees_usd,
      avg_cost_sol, avg_cost_usd,
      realized_sol, realized_usd,
      first_trade_at, last_trade_at, last_updated_at
    )
    SELECT
      NEW.wallet_id, NEW.wallet_alias, NEW.coin_mint, NEW.trade_uuid,
      COALESCE(NEW.token_amount, 0), COALESCE(NEW.sol_amount, 0),
      COALESCE(NEW.fees_sol, 0), COALESCE(NEW.fees_usd, 0),
      CASE WHEN COALESCE(NEW.token_amount, 0) > 0 THEN ABS(COALESCE(NEW.sol_amount, 0)) / NEW.token_amount ELSE 0 END,
      CASE WHEN COALESCE(NEW.token_amount, 0) > 0 THEN (ABS(COALESCE(NEW.sol_amount, 0)) / NEW.token_amount) * COALESCE(NEW.sol_usd_price, 0) ELSE 0 END,
      0, 0,
      NEW.executed_at, NEW.executed_at, NEW.executed_at
    WHERE NEW.trade_uuid IS NOT NULL
    ON CONFLICT(wallet_id, coin_mint, trade_uuid) DO UPDATE SET
      wallet_alias        = COALESCE(excluded.wallet_alias, sc_pnl_positions.wallet_alias),
      total_tokens_bought = sc_pnl_positions.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0),
      total_sol_spent     = sc_pnl_positions.total_sol_spent + COALESCE(excluded.total_sol_spent, 0),
      fees_sol            = sc_pnl_positions.fees_sol + COALESCE(excluded.fees_sol, 0),
      fees_usd            = sc_pnl_positions.fees_usd + COALESCE(excluded.fees_usd, 0),
      avg_cost_sol        = CASE
                              WHEN (sc_pnl_positions.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0)) > 0
                              THEN ABS(sc_pnl_positions.total_sol_spent + COALESCE(excluded.total_sol_spent, 0))
                                   / (sc_pnl_positions.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0))
                              ELSE sc_pnl_positions.avg_cost_sol
                            END,
      avg_cost_usd        = CASE
                              WHEN (sc_pnl_positions.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0)) > 0
                              THEN (ABS(sc_pnl_positions.total_sol_spent + COALESCE(excluded.total_sol_spent, 0)) * COALESCE(NEW.sol_usd_price, 0))
                                   / (sc_pnl_positions.total_tokens_bought + COALESCE(excluded.total_tokens_bought, 0))
                              ELSE sc_pnl_positions.avg_cost_usd
                            END,
      first_trade_at      = COALESCE(sc_pnl_positions.first_trade_at, excluded.first_trade_at),
      last_trade_at       = MAX(sc_pnl_positions.last_trade_at, excluded.last_trade_at),
      last_updated_at     = excluded.last_updated_at;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_sc_pnl_sell
  AFTER INSERT ON sc_trades
  WHEN NEW.side = 'sell'
  BEGIN
    INSERT INTO sc_pnl (
      wallet_id, wallet_alias, coin_mint,
      total_tokens_sold, total_sol_received,
      fees_sol, fees_usd,
      realized_sol, realized_usd,
      first_trade_at, last_trade_at, last_updated_at
    ) VALUES (
      NEW.wallet_id, NEW.wallet_alias, NEW.coin_mint,
      COALESCE(NEW.token_amount, 0), COALESCE(NEW.sol_amount, 0),
      COALESCE(NEW.fees_sol, 0), COALESCE(NEW.fees_usd, 0),
      COALESCE(NEW.sol_amount, 0), COALESCE(NEW.sol_amount, 0) * COALESCE(NEW.sol_usd_price, 0),
      NEW.executed_at, NEW.executed_at, NEW.executed_at
    )
    ON CONFLICT(wallet_id, coin_mint) DO UPDATE SET
      wallet_alias        = COALESCE(excluded.wallet_alias, sc_pnl.wallet_alias),
      total_tokens_sold   = sc_pnl.total_tokens_sold + COALESCE(excluded.total_tokens_sold, 0),
      total_sol_received  = sc_pnl.total_sol_received + COALESCE(excluded.total_sol_received, 0),
      fees_sol            = sc_pnl.fees_sol + COALESCE(excluded.fees_sol, 0),
      fees_usd            = sc_pnl.fees_usd + COALESCE(excluded.fees_usd, 0),
      realized_sol        = sc_pnl.realized_sol + (
                            COALESCE(NEW.sol_amount, 0) - (COALESCE(NEW.token_amount, 0) * COALESCE(sc_pnl.avg_cost_sol, 0))
                          ),
      realized_usd        = sc_pnl.realized_usd + (
                            (COALESCE(NEW.sol_amount, 0) - (COALESCE(NEW.token_amount, 0) * COALESCE(sc_pnl.avg_cost_sol, 0)))
                            * COALESCE(NEW.sol_usd_price, 0)
                          ),
      first_trade_at      = COALESCE(sc_pnl.first_trade_at, excluded.first_trade_at),
      last_trade_at       = MAX(sc_pnl.last_trade_at, excluded.last_trade_at),
      last_updated_at     = excluded.last_updated_at;

    -- Position-run rollup (only when a trade_uuid is present)
    INSERT INTO sc_pnl_positions (
      wallet_id, wallet_alias, coin_mint, trade_uuid,
      total_tokens_sold, total_sol_received,
      fees_sol, fees_usd,
      realized_sol, realized_usd,
      first_trade_at, last_trade_at, last_updated_at
    )
    SELECT
      NEW.wallet_id, NEW.wallet_alias, NEW.coin_mint, NEW.trade_uuid,
      COALESCE(NEW.token_amount, 0), COALESCE(NEW.sol_amount, 0),
      COALESCE(NEW.fees_sol, 0), COALESCE(NEW.fees_usd, 0),
      COALESCE(NEW.sol_amount, 0), COALESCE(NEW.sol_amount, 0) * COALESCE(NEW.sol_usd_price, 0),
      NEW.executed_at, NEW.executed_at, NEW.executed_at
    WHERE NEW.trade_uuid IS NOT NULL
    ON CONFLICT(wallet_id, coin_mint, trade_uuid) DO UPDATE SET
      wallet_alias        = COALESCE(excluded.wallet_alias, sc_pnl_positions.wallet_alias),
      total_tokens_sold   = sc_pnl_positions.total_tokens_sold + COALESCE(excluded.total_tokens_sold, 0),
      total_sol_received  = sc_pnl_positions.total_sol_received + COALESCE(excluded.total_sol_received, 0),
      fees_sol            = sc_pnl_positions.fees_sol + COALESCE(excluded.fees_sol, 0),
      fees_usd            = sc_pnl_positions.fees_usd + COALESCE(excluded.fees_usd, 0),
      realized_sol        = sc_pnl_positions.realized_sol + (
                            COALESCE(NEW.sol_amount, 0) - (COALESCE(NEW.token_amount, 0) * COALESCE(sc_pnl_positions.avg_cost_sol, 0))
                          ),
      realized_usd        = sc_pnl_positions.realized_usd + (
                            (COALESCE(NEW.sol_amount, 0) - (COALESCE(NEW.token_amount, 0) * COALESCE(sc_pnl_positions.avg_cost_sol, 0)))
                            * COALESCE(NEW.sol_usd_price, 0)
                          ),
      first_trade_at      = COALESCE(sc_pnl_positions.first_trade_at, excluded.first_trade_at),
      last_trade_at       = MAX(sc_pnl_positions.last_trade_at, excluded.last_trade_at),
      last_updated_at     = excluded.last_updated_at;
  END;

  -- Helpful indexes for frequent lookups/cleanup
  CREATE INDEX IF NOT EXISTS idx_coins_status ON coins(status);
  CREATE INDEX IF NOT EXISTS idx_coins_lastUpdated ON coins(lastUpdated);
  CREATE INDEX IF NOT EXISTS idx_pools_coin_mint ON pools(coin_mint);
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

  CREATE INDEX IF NOT EXISTS idx_sc_trades_wallet_session
  ON sc_trades (wallet_id, session_id);

CREATE INDEX IF NOT EXISTS idx_sc_trades_session
  ON sc_trades (session_id);

  CREATE INDEX IF NOT EXISTS idx_sc_pnl_wallet_mint
  ON sc_pnl (wallet_id, coin_mint);

CREATE INDEX IF NOT EXISTS idx_sc_trades_wallet_executed
  ON sc_trades (wallet_id, executed_at DESC);

  CREATE INDEX IF NOT EXISTS idx_sc_trades_trade_uuid
    ON sc_trades (trade_uuid);

  CREATE INDEX IF NOT EXISTS idx_sc_pnl_positions_wallet_mint_uuid
    ON sc_pnl_positions (wallet_id, coin_mint, trade_uuid);

  CREATE INDEX IF NOT EXISTS idx_pending_trade_uuids_created_at
    ON pending_trade_uuids (created_at);

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_sc_positions_open_wallet_mint
  ON sc_positions(wallet_id, coin_mint)
  WHERE closed_at = 0;
`);

  // Ensure txid is unique for UPSERTs. Older DB files may have been created before UNIQUE(txid) existed.
  // This is safe to run repeatedly; it will no-op if already present.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_trades_txid ON sc_trades(txid)');


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

ensureColumn(db, "sc_wallets", "usage_type", "TEXT NOT NULL DEFAULT 'other'");
ensureColumn(db, "sc_wallets", "is_default_funding", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "sc_wallets", "auto_attach_warchest", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "sc_wallets", "strategy_id", "TEXT");

ensureColumn(db, 'sc_sessions', 'service_instance_id', 'TEXT');
ensureColumn(db, 'sc_sessions', 'start_slot', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'start_block_time', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'end_slot', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'end_block_time', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'last_refresh_at', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'last_refresh_slot', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'last_refresh_block_time', 'INTEGER');
ensureColumn(db, 'sc_sessions', 'trades_count', 'INTEGER DEFAULT 0');
ensureColumn(db, 'sc_sessions', 'fees_usd', 'REAL DEFAULT 0');
ensureColumn(db, 'sc_sessions', 'buys_usd', 'REAL DEFAULT 0');
ensureColumn(db, 'sc_sessions', 'sells_usd', 'REAL DEFAULT 0');

ensureColumn(db, "sc_trades", "created_at", "INTEGER");
ensureColumn(db, "sc_trades", "updated_at", "INTEGER");
ensureColumn(db, "sc_trades", "session_id", "INTEGER");
ensureColumn(db, "sc_trades", "trade_uuid", "TEXT");

ensureColumn(db, "pending_trade_uuids", "wallet_id", "INTEGER");
ensureColumn(db, "pending_trade_uuids", "mint", "TEXT NOT NULL");
ensureColumn(db, "pending_trade_uuids", "trade_uuid", "TEXT NOT NULL");
ensureColumn(db, "pending_trade_uuids", "created_at", "INTEGER NOT NULL");

ensureColumn(db, "sc_pnl_positions", "wallet_alias", "TEXT");
ensureColumn(db, "sc_pnl_positions", "total_tokens_bought", "REAL");
ensureColumn(db, "sc_pnl_positions", "total_tokens_sold", "REAL");
ensureColumn(db, "sc_pnl_positions", "total_sol_spent", "REAL");
ensureColumn(db, "sc_pnl_positions", "total_sol_received", "REAL");
ensureColumn(db, "sc_pnl_positions", "fees_sol", "REAL");
ensureColumn(db, "sc_pnl_positions", "fees_usd", "REAL");
ensureColumn(db, "sc_pnl_positions", "avg_cost_sol", "REAL");
ensureColumn(db, "sc_pnl_positions", "avg_cost_usd", "REAL");
ensureColumn(db, "sc_pnl_positions", "realized_sol", "REAL");
ensureColumn(db, "sc_pnl_positions", "realized_usd", "REAL");
ensureColumn(db, "sc_pnl_positions", "first_trade_at", "INTEGER");
ensureColumn(db, "sc_pnl_positions", "last_trade_at", "INTEGER");
ensureColumn(db, "sc_pnl_positions", "last_updated_at", "INTEGER");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sc_wallets_usage_type
    ON sc_wallets (usage_type);

  CREATE INDEX IF NOT EXISTS idx_sc_wallets_default_funding
    ON sc_wallets (is_default_funding);

  CREATE INDEX IF NOT EXISTS idx_sc_wallets_auto_attach
    ON sc_wallets (auto_attach_warchest);
`);
}

module.exports = { ensureSqliteSchema };
