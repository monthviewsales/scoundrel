-- 003_wallet_usage_flags.mysql.sql
-- Add usage / role metadata to sc_wallets for Scoundrel warchest.

ALTER TABLE sc_wallets
  ADD COLUMN usage_type ENUM('funding','strategy','kol','deployer','other')
    NOT NULL DEFAULT 'other'
    AFTER pubkey,
  ADD COLUMN is_default_funding TINYINT(1)
    NOT NULL DEFAULT 0
    AFTER usage_type,
  ADD COLUMN auto_attach_warchest TINYINT(1)
    NOT NULL DEFAULT 0
    AFTER is_default_funding,
  ADD COLUMN strategy_id VARCHAR(64)
    NULL
    AFTER auto_attach_warchest;

ALTER TABLE sc_wallets
  ADD INDEX idx_sc_wallets_usage_type (usage_type),
  ADD INDEX idx_sc_wallets_default_funding (is_default_funding),
  ADD INDEX idx_sc_wallets_auto_attach (auto_attach_warchest);

-- NOTE: After running this migration, set your master wallet explicitly:
--   UPDATE sc_wallets
--   SET usage_type = 'funding',
--       is_default_funding = 1,
--       auto_attach_warchest = 1
--   WHERE alias = 'warlord';
