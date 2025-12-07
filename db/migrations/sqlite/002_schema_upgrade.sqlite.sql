-- 002: Schema upgrade for BootyBox (SQLite)
-- Brings an 001-era DB up to parity with current adapters/sqliteSchema.js

-- =============
-- COINS upgrades
-- =============

ALTER TABLE coins ADD COLUMN priceSol       REAL;
ALTER TABLE coins ADD COLUMN priceUsd       REAL;
ALTER TABLE coins ADD COLUMN liquiditySol   REAL;
ALTER TABLE coins ADD COLUMN liquidityUsd   REAL;
ALTER TABLE coins ADD COLUMN marketCapSol   REAL;
ALTER TABLE coins ADD COLUMN marketCapUsd   REAL;
ALTER TABLE coins ADD COLUMN tokenCreatedAt INTEGER;
ALTER TABLE coins ADD COLUMN firstSeenAt    INTEGER;
ALTER TABLE coins ADD COLUMN strictSocials  TEXT;


-- =============
-- POOLS upgrades
-- =============

ALTER TABLE pools ADD COLUMN txns_buys       INTEGER;
ALTER TABLE pools ADD COLUMN txns_sells      INTEGER;
ALTER TABLE pools ADD COLUMN txns_total      INTEGER;
ALTER TABLE pools ADD COLUMN volume_quote    REAL;
ALTER TABLE pools ADD COLUMN volume24h_quote REAL;
ALTER TABLE pools ADD COLUMN deployer        TEXT;


-- ==============
-- EVENTS upgrades
-- ==============

ALTER TABLE events ADD COLUMN insertedAt                 INTEGER;
ALTER TABLE events ADD COLUMN previousUpdatedAt          INTEGER;
ALTER TABLE events ADD COLUMN updatedAt                  INTEGER;
ALTER TABLE events ADD COLUMN priceChangePercentageDelta REAL;
ALTER TABLE events ADD COLUMN volumeSol                  REAL;
ALTER TABLE events ADD COLUMN volumeSolDelta             REAL;
ALTER TABLE events ADD COLUMN volumeUsd                  REAL;
ALTER TABLE events ADD COLUMN volumeUsdDelta             REAL;
ALTER TABLE events ADD COLUMN buysCount                  INTEGER;
ALTER TABLE events ADD COLUMN buysCountDelta             INTEGER;
ALTER TABLE events ADD COLUMN sellsCount                 INTEGER;
ALTER TABLE events ADD COLUMN sellsCountDelta            INTEGER;
ALTER TABLE events ADD COLUMN txnsCount                  INTEGER;
ALTER TABLE events ADD COLUMN txnsCountDelta             INTEGER;
ALTER TABLE events ADD COLUMN holdersCount               INTEGER;
ALTER TABLE events ADD COLUMN holdersCountDelta          INTEGER;


-- ============
-- RISK upgrades
-- ============

ALTER TABLE risk ADD COLUMN insertedAt                 INTEGER;
ALTER TABLE risk ADD COLUMN previousUpdatedAt          INTEGER;
ALTER TABLE risk ADD COLUMN updatedAt                  INTEGER;

ALTER TABLE risk ADD COLUMN snipersCount               INTEGER;
ALTER TABLE risk ADD COLUMN snipersTotalBalance        REAL;
ALTER TABLE risk ADD COLUMN snipersTotalPercent        REAL;
ALTER TABLE risk ADD COLUMN snipersCountDelta          INTEGER;
ALTER TABLE risk ADD COLUMN snipersTotalBalanceDelta   REAL;
ALTER TABLE risk ADD COLUMN snipersTotalPercentDelta   REAL;

ALTER TABLE risk ADD COLUMN insidersCount              INTEGER;
ALTER TABLE risk ADD COLUMN insidersTotalBalance       REAL;
ALTER TABLE risk ADD COLUMN insidersTotalPercent       REAL;
ALTER TABLE risk ADD COLUMN insidersCountDelta         INTEGER;
ALTER TABLE risk ADD COLUMN insidersTotalBalanceDelta  REAL;
ALTER TABLE risk ADD COLUMN insidersTotalPercentDelta  REAL;

ALTER TABLE risk ADD COLUMN top10Percent               REAL;
ALTER TABLE risk ADD COLUMN top10PercentDelta          REAL;

ALTER TABLE risk ADD COLUMN devPercent                 REAL;
ALTER TABLE risk ADD COLUMN devPercentDelta            REAL;
ALTER TABLE risk ADD COLUMN devAmountTokens            REAL;
ALTER TABLE risk ADD COLUMN devAmountTokensDelta       REAL;

ALTER TABLE risk ADD COLUMN feesTotalSol               REAL;
ALTER TABLE risk ADD COLUMN feesTotalSolDelta          REAL;

ALTER TABLE risk ADD COLUMN riskScoreDelta             REAL;
ALTER TABLE risk ADD COLUMN risksJson                  TEXT;


-- =================
-- POSITIONS upgrades
-- =================

ALTER TABLE positions ADD COLUMN entryAmt        REAL;        -- tokens at entry
ALTER TABLE positions ADD COLUMN holdingAmt      REAL;        -- current tokens held
ALTER TABLE positions ADD COLUMN walletId        INTEGER;     -- FK to sc_wallets.wallet_id
ALTER TABLE positions ADD COLUMN walletAlias     TEXT;        -- denormalized alias
ALTER TABLE positions ADD COLUMN entryPriceSol   REAL;        -- canonical SOL entry price
ALTER TABLE positions ADD COLUMN currentPriceSol REAL;        -- latest SOL price
ALTER TABLE positions ADD COLUMN currentPriceUsd REAL;        -- latest USD price
ALTER TABLE positions ADD COLUMN highestPriceSol REAL;        -- canonical SOL high watermark
ALTER TABLE positions ADD COLUMN source          TEXT;        -- bot/human origin tag
ALTER TABLE positions ADD COLUMN lastUpdated     INTEGER;     -- last refresh timestamp (ms)