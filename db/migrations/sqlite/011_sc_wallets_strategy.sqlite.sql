-- 011: rename sc_wallets.strategy_id -> strategy

ALTER TABLE sc_wallets
  RENAME COLUMN strategy_id TO strategy;
