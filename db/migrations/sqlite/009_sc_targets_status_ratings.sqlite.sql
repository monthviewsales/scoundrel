-- 009: allow rating-style statuses in sc_targets

CREATE TABLE sc_targets_next (
  target_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  mint             TEXT NOT NULL UNIQUE,
  symbol           TEXT,
  name             TEXT,
  status           TEXT NOT NULL CHECK(status IN ('new','watching','approved','rejected','archived','strong_buy','buy','watch','avoid')) DEFAULT 'new',
  strategy         TEXT,
  strategy_id      TEXT,
  source           TEXT,
  tags             TEXT,
  notes            TEXT,
  vector_store_id  TEXT,
  vector_store_file_id TEXT,
  vector_store_updated_at INTEGER,
  confidence       REAL,
  score            REAL,
  mint_verified    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER,
  updated_at       INTEGER,
  last_checked_at  INTEGER
);

INSERT INTO sc_targets_next (
  target_id,
  mint,
  symbol,
  name,
  status,
  strategy,
  strategy_id,
  source,
  tags,
  notes,
  vector_store_id,
  vector_store_file_id,
  vector_store_updated_at,
  confidence,
  score,
  mint_verified,
  created_at,
  updated_at,
  last_checked_at
)
SELECT
  target_id,
  mint,
  symbol,
  name,
  status,
  strategy,
  strategy_id,
  source,
  tags,
  notes,
  NULL,
  NULL,
  NULL,
  confidence,
  score,
  mint_verified,
  created_at,
  updated_at,
  last_checked_at
FROM sc_targets;

DROP TABLE sc_targets;
ALTER TABLE sc_targets_next RENAME TO sc_targets;

CREATE INDEX IF NOT EXISTS idx_sc_targets_status ON sc_targets(status);
CREATE INDEX IF NOT EXISTS idx_sc_targets_strategy ON sc_targets(strategy);
CREATE INDEX IF NOT EXISTS idx_sc_targets_last_checked_at ON sc_targets(last_checked_at);
