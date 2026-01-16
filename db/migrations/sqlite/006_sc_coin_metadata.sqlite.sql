-- 006: Add sc_coin_metadata table for devscan mint metadata

CREATE TABLE IF NOT EXISTS sc_coin_metadata (
  metadata_id TEXT PRIMARY KEY,
  mint        TEXT NOT NULL,
  source      TEXT NOT NULL,
  response_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(mint, source)
);
