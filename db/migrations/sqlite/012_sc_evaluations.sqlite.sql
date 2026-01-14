-- 012: unify buyOps + sellOps evaluations into sc_evaluations

CREATE TABLE IF NOT EXISTS sc_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Timing / identity
  ops_type VARCHAR(16) NOT NULL,
  ts_ms BIGINT NOT NULL,
  wallet_id INTEGER NOT NULL,
  wallet_alias VARCHAR(64) NOT NULL,

  trade_uuid CHAR(36),
  coin_mint VARCHAR(64) NOT NULL,
  symbol VARCHAR(32),

  -- Target snapshot (buyOps only)
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

  -- Position snapshot
  unreal_usd DOUBLE,
  total_usd DOUBLE,
  roi_pct DOUBLE,

  -- Reasons & raw payload
  reasons_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,

  -- Metadata
  inserted_at BIGINT NOT NULL
);

-- Ensure legacy tables exist for data copy (no-op if already present)
CREATE TABLE IF NOT EXISTS sc_sellops_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms BIGINT NOT NULL,
  wallet_id INTEGER NOT NULL,
  wallet_alias VARCHAR(64) NOT NULL,
  trade_uuid CHAR(36) NOT NULL,
  coin_mint VARCHAR(64) NOT NULL,
  symbol VARCHAR(32),
  strategy_name VARCHAR(32),
  strategy_source VARCHAR(32),
  recommendation VARCHAR(16) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  regime VARCHAR(16),
  qualify_failed_count INTEGER DEFAULT 0,
  qualify_worst_severity VARCHAR(16),
  gate_fail VARCHAR(64),
  price_usd DOUBLE,
  liquidity_usd DOUBLE,
  chart_interval VARCHAR(8),
  chart_points INTEGER,
  rsi DOUBLE,
  macd_hist DOUBLE,
  vwap DOUBLE,
  warnings_count INTEGER DEFAULT 0,
  unreal_usd DOUBLE,
  total_usd DOUBLE,
  roi_pct DOUBLE,
  reasons_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  inserted_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sc_buyops_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms BIGINT NOT NULL,
  wallet_id INTEGER NOT NULL,
  wallet_alias VARCHAR(64) NOT NULL,
  trade_uuid CHAR(36),
  coin_mint VARCHAR(64) NOT NULL,
  symbol VARCHAR(32),
  target_status VARCHAR(16),
  target_score DOUBLE,
  target_confidence DOUBLE,
  strategy_name VARCHAR(32),
  strategy_source VARCHAR(32),
  recommendation VARCHAR(16) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  regime VARCHAR(16),
  qualify_failed_count INTEGER DEFAULT 0,
  qualify_worst_severity VARCHAR(16),
  gate_fail VARCHAR(64),
  price_usd DOUBLE,
  liquidity_usd DOUBLE,
  chart_interval VARCHAR(8),
  chart_points INTEGER,
  rsi DOUBLE,
  macd_hist DOUBLE,
  vwap DOUBLE,
  warnings_count INTEGER DEFAULT 0,
  unreal_usd DOUBLE,
  total_usd DOUBLE,
  roi_pct DOUBLE,
  reasons_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  inserted_at BIGINT NOT NULL
);

INSERT INTO sc_evaluations (
  ops_type,
  ts_ms,
  wallet_id,
  wallet_alias,
  trade_uuid,
  coin_mint,
  symbol,
  target_status,
  target_score,
  target_confidence,
  strategy_name,
  strategy_source,
  recommendation,
  decision,
  regime,
  qualify_failed_count,
  qualify_worst_severity,
  gate_fail,
  price_usd,
  liquidity_usd,
  chart_interval,
  chart_points,
  rsi,
  macd_hist,
  vwap,
  warnings_count,
  unreal_usd,
  total_usd,
  roi_pct,
  reasons_json,
  payload_json,
  inserted_at
)
SELECT
  'sellOps' AS ops_type,
  ts_ms,
  wallet_id,
  wallet_alias,
  trade_uuid,
  coin_mint,
  symbol,
  NULL AS target_status,
  NULL AS target_score,
  NULL AS target_confidence,
  strategy_name,
  strategy_source,
  recommendation,
  decision,
  regime,
  qualify_failed_count,
  qualify_worst_severity,
  gate_fail,
  price_usd,
  liquidity_usd,
  chart_interval,
  chart_points,
  rsi,
  macd_hist,
  vwap,
  warnings_count,
  unreal_usd,
  total_usd,
  roi_pct,
  reasons_json,
  payload_json,
  inserted_at
FROM sc_sellops_evaluations;

INSERT INTO sc_evaluations (
  ops_type,
  ts_ms,
  wallet_id,
  wallet_alias,
  trade_uuid,
  coin_mint,
  symbol,
  target_status,
  target_score,
  target_confidence,
  strategy_name,
  strategy_source,
  recommendation,
  decision,
  regime,
  qualify_failed_count,
  qualify_worst_severity,
  gate_fail,
  price_usd,
  liquidity_usd,
  chart_interval,
  chart_points,
  rsi,
  macd_hist,
  vwap,
  warnings_count,
  unreal_usd,
  total_usd,
  roi_pct,
  reasons_json,
  payload_json,
  inserted_at
)
SELECT
  'buyOps' AS ops_type,
  ts_ms,
  wallet_id,
  wallet_alias,
  trade_uuid,
  coin_mint,
  symbol,
  target_status,
  target_score,
  target_confidence,
  strategy_name,
  strategy_source,
  recommendation,
  decision,
  regime,
  qualify_failed_count,
  qualify_worst_severity,
  gate_fail,
  price_usd,
  liquidity_usd,
  chart_interval,
  chart_points,
  rsi,
  macd_hist,
  vwap,
  warnings_count,
  unreal_usd,
  total_usd,
  roi_pct,
  reasons_json,
  payload_json,
  inserted_at
FROM sc_buyops_evaluations;

DROP TABLE IF EXISTS sc_sellops_evaluations;
DROP TABLE IF EXISTS sc_buyops_evaluations;

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
