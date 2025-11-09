-- Scoundrel initial schema: sc_asks, sc_tunes, sc_profiles
-- Engine/charset aligned for wide compatibility

CREATE TABLE IF NOT EXISTS sc_asks (
  ask_id CHAR(26) NOT NULL PRIMARY KEY,
  correlation_id CHAR(26) NULL,
  question TEXT NOT NULL,
  profile JSON NULL,
  `rows` JSON NULL,
  model VARCHAR(64) NOT NULL,
  temperature DECIMAL(3,2) NOT NULL,
  response_raw JSON NOT NULL,
  answer TEXT NOT NULL,
  bullets JSON NOT NULL,
  actions JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sc_asks_created_at (created_at),
  INDEX idx_sc_asks_model (model)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sc_tunes (
  tune_id CHAR(26) NOT NULL PRIMARY KEY,
  correlation_id CHAR(26) NULL,
  profile JSON NULL,
  current_settings JSON NULL,
  model VARCHAR(64) NOT NULL,
  temperature DECIMAL(3,2) NOT NULL,
  response_raw JSON NOT NULL,
  answer TEXT NOT NULL,
  bullets JSON NOT NULL,
  actions JSON NOT NULL,
  changes JSON NOT NULL,
  patch JSON NOT NULL,
  risks JSON NOT NULL,
  rationale TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sc_tunes_created_at (created_at),
  INDEX idx_sc_tunes_model (model)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- Persist trader profiles built by Scoundrel
CREATE TABLE IF NOT EXISTS sc_profiles (
  profile_id CHAR(26) NOT NULL PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  wallet VARCHAR(64) NOT NULL,
  profile JSON NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'build-profile',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sc_profiles_name (name),
  INDEX idx_sc_profiles_wallet (wallet)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- Persist outputs for all AI jobs (v1 simple)
CREATE TABLE IF NOT EXISTS sc_job_runs (
  job_run_id  CHAR(26)   NOT NULL PRIMARY KEY,  -- ULID
  job         VARCHAR(64) NOT NULL,             -- e.g., walletAnalysis
  context     JSON        NULL,                 -- free-form tags: { wallet, tradeId, mint, label, ... }
  input       JSON        NOT NULL,             -- payload given to the job (e.g., merged)
  response_raw JSON       NOT NULL,             -- raw model output
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sc_job_runs_job_created (job, created_at)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;