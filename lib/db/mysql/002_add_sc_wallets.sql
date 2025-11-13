-- 002_add_sc_wallets.sql
-- Warchest wallet registry for Scoundrel
-- Stores aliases, public keys, display color, and key storage metadata.

CREATE TABLE IF NOT EXISTS sc_wallets (
  wallet_id       BIGINT UNSIGNED                    NOT NULL AUTO_INCREMENT,
  alias           VARCHAR(64)                        NOT NULL,
  pubkey          VARCHAR(64)                        NOT NULL,
  color           VARCHAR(16)                        DEFAULT NULL,
  has_private_key TINYINT(1)                         NOT NULL DEFAULT 0,
  key_source      ENUM('none', 'keychain', 'db_encrypted')
                                                     NOT NULL DEFAULT 'none',
  -- key_ref holds either:
  --   - keychain identifier (e.g. "scoundrel.wallet:warlord"), or
  --   - JSON / metadata for an encrypted private key blob
  key_ref         TEXT                               DEFAULT NULL,
  created_at      TIMESTAMP                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP                          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (wallet_id),
  UNIQUE KEY uq_sc_wallets_alias (alias),
  KEY idx_sc_wallets_pubkey (pubkey)
) ENGINE=InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;