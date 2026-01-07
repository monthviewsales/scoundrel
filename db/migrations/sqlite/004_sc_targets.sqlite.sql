-- 004: sc_targets table for token target lists

CREATE TABLE IF NOT EXISTS sc_targets (
  target_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  mint             TEXT NOT NULL UNIQUE,
  symbol           TEXT,
  name             TEXT,
  status           TEXT NOT NULL CHECK(status IN ('new','watching','approved','rejected','archived')) DEFAULT 'new',
  strategy         TEXT,
  strategy_id      TEXT,
  source           TEXT,
  tags             TEXT,
  notes            TEXT,
  confidence       REAL,
  score            REAL,
  mint_verified    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER,
  updated_at       INTEGER,
  last_checked_at  INTEGER
);
