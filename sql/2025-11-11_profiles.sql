-- Wallet profile persistence schema
-- Created 2025-11-11
-- Requires MySQL 5.7.8+ (JSON) — confirmed 9.0.4 in your env

CREATE TABLE IF NOT EXISTS sc_wallet_profiles (
  wallet            VARCHAR(64) PRIMARY KEY,
  version           INT NOT NULL,
  technique_json    JSON,
  outcomes_json     JSON,
  heuristics_json   JSON,
  enrichment_json   JSON,
  updated_at        DATETIME(6) NOT NULL,
  INDEX idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sc_wallet_profile_versions (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  wallet            VARCHAR(64) NOT NULL,
  version           INT NOT NULL,
  technique_json    JSON,
  outcomes_json     JSON,
  heuristics_json   JSON,
  enrichment_json   JSON,
  created_at        DATETIME(6) NOT NULL,
  INDEX idx_wallet_version (wallet, version),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sc_wallet_profile_index (
  wallet            VARCHAR(64) PRIMARY KEY,
  style             VARCHAR(32),
  entry_technique   VARCHAR(32),
  win_rate          DECIMAL(6,4),
  median_exit_pct   DECIMAL(10,4),
  median_hold_mins  DECIMAL(10,2),
  last_seen_at      DATETIME(6) NOT NULL,
  INDEX idx_style (style),
  INDEX idx_entry_tech (entry_technique),
  INDEX idx_winrate (win_rate),
  INDEX idx_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
