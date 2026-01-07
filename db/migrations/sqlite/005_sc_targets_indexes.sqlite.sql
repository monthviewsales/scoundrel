-- 005: sc_targets indexes for common query filters

CREATE INDEX IF NOT EXISTS idx_sc_targets_status ON sc_targets(status);
CREATE INDEX IF NOT EXISTS idx_sc_targets_strategy ON sc_targets(strategy);
CREATE INDEX IF NOT EXISTS idx_sc_targets_last_checked_at ON sc_targets(last_checked_at);
