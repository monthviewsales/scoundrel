-- 014: Scoundrel runtime tables + indexes missing from migrations

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

CREATE TABLE IF NOT EXISTS sc_positions (
  position_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id             INTEGER NOT NULL,
  wallet_alias          TEXT,
  coin_mint             TEXT NOT NULL,
  trade_uuid            TEXT,
  strategy_id           TEXT,
  strategy_name         TEXT,
  open_at               INTEGER,
  closed_at             INTEGER NOT NULL DEFAULT 0,
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

ALTER TABLE pending_trade_uuids RENAME TO pending_trade_uuids_old;

CREATE TABLE pending_trade_uuids (
  wallet_id    INTEGER,
  mint         TEXT NOT NULL,
  trade_uuid   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(wallet_id, mint)
);

INSERT INTO pending_trade_uuids (wallet_id, mint, trade_uuid, created_at)
SELECT NULL, mint, trade_uuid, created_at
FROM pending_trade_uuids_old;

DROP TABLE pending_trade_uuids_old;

CREATE TABLE IF NOT EXISTS sc_sessions (
  session_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service                 TEXT NOT NULL,
  service_instance_id     TEXT NOT NULL,
  started_at              INTEGER NOT NULL,
  start_slot              INTEGER NOT NULL,
  start_block_time        INTEGER,
  ended_at                INTEGER,
  end_slot                INTEGER,
  end_block_time          INTEGER,
  end_reason              TEXT,
  last_refresh_at         INTEGER,
  last_refresh_slot       INTEGER,
  last_refresh_block_time INTEGER,
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
  avg_cost_sol         REAL    DEFAULT 0,
  avg_cost_usd         REAL    DEFAULT 0,
  realized_sol         REAL    DEFAULT 0,
  realized_usd         REAL    DEFAULT 0,
  first_trade_at       INTEGER,
  last_trade_at        INTEGER,
  last_updated_at      INTEGER,
  PRIMARY KEY (wallet_id, coin_mint)
);

CREATE TABLE IF NOT EXISTS sc_pnl_positions (
  wallet_id            INTEGER NOT NULL,
  wallet_alias         TEXT,
  coin_mint            TEXT NOT NULL,
  trade_uuid           TEXT NOT NULL,
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
    p.current_token_amount,
    c.priceSol AS coin_price_sol,
    c.priceUsd AS coin_price_usd,
    (p.current_token_amount * c.priceSol) AS unrealized_sol,
    (p.current_token_amount * c.priceUsd) AS unrealized_usd,
    (COALESCE(pn.realized_sol, 0) + (p.current_token_amount * c.priceSol)) AS total_sol,
    (COALESCE(pn.realized_usd, 0) + (p.current_token_amount * c.priceUsd)) AS total_usd,
    pn.first_trade_at,
    pn.last_trade_at,
    pn.last_updated_at
  FROM sc_positions p
  LEFT JOIN sc_pnl_positions pn
    ON pn.wallet_id = p.wallet_id AND pn.coin_mint = p.coin_mint AND pn.trade_uuid = p.trade_uuid
  LEFT JOIN coins c
    ON c.mint = p.coin_mint;

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_trades_txid
  ON sc_trades(txid);

CREATE INDEX IF NOT EXISTS idx_evals_wallet_time
  ON sc_evaluations (wallet_id, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_trade_time
  ON sc_evaluations (wallet_id, trade_uuid, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_mint_time
  ON sc_evaluations (coin_mint, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_ops_type
  ON sc_evaluations (ops_type, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_decision
  ON sc_evaluations (decision, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_recommendation
  ON sc_evaluations (recommendation, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_gate_fail
  ON sc_evaluations (gate_fail, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_strategy
  ON sc_evaluations (strategy_name, ts_ms);

CREATE INDEX IF NOT EXISTS idx_evals_target_status
  ON sc_evaluations (target_status, ts_ms);
