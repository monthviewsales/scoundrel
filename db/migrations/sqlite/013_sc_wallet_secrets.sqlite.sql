-- Add encrypted wallet secrets table for Keychain-backed storage
CREATE TABLE IF NOT EXISTS sc_wallet_secrets (
  secret_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id    INTEGER NOT NULL UNIQUE,
  cipher_text  TEXT NOT NULL,
  iv           TEXT NOT NULL,
  auth_tag     TEXT NOT NULL,
  algorithm    TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sc_wallet_secrets_wallet_id
  ON sc_wallet_secrets(wallet_id);
