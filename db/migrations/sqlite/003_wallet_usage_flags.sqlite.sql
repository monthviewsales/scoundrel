-- 003_wallet_usage_flags.sqlite.sql
-- Add usage / role metadata to sc_wallets for Scoundrel warchest (SQLite version).
-- SQLite does not support ENUM; we use TEXT for usage_type.

ALTER TABLE sc_wallets
  ADD COLUMN usage_type TEXT NOT NULL DEFAULT 'other';

ALTER TABLE sc_wallets
  ADD COLUMN is_default_funding INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sc_wallets
  ADD COLUMN auto_attach_warchest INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sc_wallets
  ADD COLUMN strategy_id TEXT NULL;

-- Create indexes to match MySQL logic.
CREATE INDEX IF NOT EXISTS idx_sc_wallets_usage_type
  ON sc_wallets (usage_type);

CREATE INDEX IF NOT EXISTS idx_sc_wallets_default_funding
  ON sc_wallets (is_default_funding);

CREATE INDEX IF NOT EXISTS idx_sc_wallets_auto_attach
  ON sc_wallets (auto_attach_warchest);

-- NOTE: After running this migration, set your master wallet explicitly:
--   UPDATE sc_wallets
--   SET usage_type = 'funding',
--       is_default_funding = 1,
--       auto_attach_warchest = 1
--   WHERE alias = 'warlord';
