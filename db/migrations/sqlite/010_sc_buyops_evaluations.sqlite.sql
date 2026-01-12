-- 010: sc_buyops_evaluations table for buyOps snapshots

CREATE TABLE IF NOT EXISTS sc_buyops_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Timing / identity
  ts_ms BIGINT NOT NULL,
  wallet_id INTEGER NOT NULL,
  wallet_alias VARCHAR(64) NOT NULL,

  trade_uuid CHAR(36),
  coin_mint VARCHAR(64) NOT NULL,
  symbol VARCHAR(32),

  -- Target snapshot
  target_status VARCHAR(16),
  target_score DOUBLE,
  target_confidence DOUBLE,

  -- Strategy & decision
  strategy_name VARCHAR(32),
  strategy_source VARCHAR(32),
  recommendation VARCHAR(16) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  regime VARCHAR(16),

  -- Qualification / gating
  qualify_failed_count INTEGER DEFAULT 0,
  qualify_worst_severity VARCHAR(16),
  gate_fail VARCHAR(64),

  -- Market snapshot
  price_usd DOUBLE,
  liquidity_usd DOUBLE,
  chart_interval VARCHAR(8),
  chart_points INTEGER,

  -- Indicators
  rsi DOUBLE,
  macd_hist DOUBLE,
  vwap DOUBLE,
  warnings_count INTEGER DEFAULT 0,

  -- Position snapshot (optional for buyOps)
  unreal_usd DOUBLE,
  total_usd DOUBLE,
  roi_pct DOUBLE,

  -- Reasons & raw payload
  reasons_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,

  -- Metadata
  inserted_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buyops_wallet_time
  ON sc_buyops_evaluations (wallet_id, ts_ms);

CREATE INDEX IF NOT EXISTS idx_buyops_mint_time
  ON sc_buyops_evaluations (coin_mint, ts_ms);

CREATE INDEX IF NOT EXISTS idx_buyops_decision
  ON sc_buyops_evaluations (decision, ts_ms);

CREATE INDEX IF NOT EXISTS idx_buyops_recommendation
  ON sc_buyops_evaluations (recommendation, ts_ms);

CREATE INDEX IF NOT EXISTS idx_buyops_strategy
  ON sc_buyops_evaluations (strategy_name, ts_ms);

CREATE INDEX IF NOT EXISTS idx_buyops_target_status
  ON sc_buyops_evaluations (target_status, ts_ms);
