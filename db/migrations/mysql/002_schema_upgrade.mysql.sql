-- 002: Schema upgrade for BootyBox (MySQL)
-- Brings an 001-era DB up to parity with current adapters/mysqlSchema.js

-- =============
-- COINS upgrades
-- =============

ALTER TABLE coins ADD COLUMN priceSol       DOUBLE;
ALTER TABLE coins ADD COLUMN priceUsd       DOUBLE;
ALTER TABLE coins ADD COLUMN liquiditySol   DOUBLE;
ALTER TABLE coins ADD COLUMN liquidityUsd   DOUBLE;
ALTER TABLE coins ADD COLUMN marketCapSol   DOUBLE;
ALTER TABLE coins ADD COLUMN marketCapUsd   DOUBLE;
ALTER TABLE coins ADD COLUMN tokenCreatedAt BIGINT;
ALTER TABLE coins ADD COLUMN firstSeenAt    BIGINT;
ALTER TABLE coins ADD COLUMN strictSocials  JSON;


-- =============
-- POOLS upgrades
-- =============

ALTER TABLE pools ADD COLUMN txns_buys       INT;
ALTER TABLE pools ADD COLUMN txns_sells      INT;
ALTER TABLE pools ADD COLUMN txns_total      INT;
ALTER TABLE pools ADD COLUMN volume_quote    DOUBLE;
ALTER TABLE pools ADD COLUMN volume24h_quote DOUBLE;
ALTER TABLE pools ADD COLUMN deployer        VARCHAR(64);


-- ==============
-- EVENTS upgrades
-- ==============

ALTER TABLE events ADD COLUMN insertedAt                 BIGINT;
ALTER TABLE events ADD COLUMN previousUpdatedAt          BIGINT;
ALTER TABLE events ADD COLUMN updatedAt                  BIGINT;
ALTER TABLE events ADD COLUMN priceChangePercentageDelta DOUBLE;
ALTER TABLE events ADD COLUMN volumeSol                  DOUBLE;
ALTER TABLE events ADD COLUMN volumeSolDelta             DOUBLE;
ALTER TABLE events ADD COLUMN volumeUsd                  DOUBLE;
ALTER TABLE events ADD COLUMN volumeUsdDelta             DOUBLE;
ALTER TABLE events ADD COLUMN buysCount                  INT;
ALTER TABLE events ADD COLUMN buysCountDelta             INT;
ALTER TABLE events ADD COLUMN sellsCount                 INT;
ALTER TABLE events ADD COLUMN sellsCountDelta            INT;
ALTER TABLE events ADD COLUMN txnsCount                  INT;
ALTER TABLE events ADD COLUMN txnsCountDelta             INT;
ALTER TABLE events ADD COLUMN holdersCount               INT;
ALTER TABLE events ADD COLUMN holdersCountDelta          INT;


-- ============
-- RISK upgrades
-- ============

ALTER TABLE risk ADD COLUMN insertedAt                 BIGINT;
ALTER TABLE risk ADD COLUMN previousUpdatedAt          BIGINT;
ALTER TABLE risk ADD COLUMN updatedAt                  BIGINT;

ALTER TABLE risk ADD COLUMN snipersCount               INT;
ALTER TABLE risk ADD COLUMN snipersTotalBalance        DOUBLE;
ALTER TABLE risk ADD COLUMN snipersTotalPercent        DOUBLE;
ALTER TABLE risk ADD COLUMN snipersCountDelta          INT;
ALTER TABLE risk ADD COLUMN snipersTotalBalanceDelta   DOUBLE;
ALTER TABLE risk ADD COLUMN snipersTotalPercentDelta   DOUBLE;

ALTER TABLE risk ADD COLUMN insidersCount              INT;
ALTER TABLE risk ADD COLUMN insidersTotalBalance       DOUBLE;
ALTER TABLE risk ADD COLUMN insidersTotalPercent       DOUBLE;
ALTER TABLE risk ADD COLUMN insidersCountDelta         INT;
ALTER TABLE risk ADD COLUMN insidersTotalBalanceDelta  DOUBLE;
ALTER TABLE risk ADD COLUMN insidersTotalPercentDelta  DOUBLE;

ALTER TABLE risk ADD COLUMN top10Percent               DOUBLE;
ALTER TABLE risk ADD COLUMN top10PercentDelta          DOUBLE;

ALTER TABLE risk ADD COLUMN devPercent                 DOUBLE;
ALTER TABLE risk ADD COLUMN devPercentDelta            DOUBLE;
ALTER TABLE risk ADD COLUMN devAmountTokens            DOUBLE;
ALTER TABLE risk ADD COLUMN devAmountTokensDelta       DOUBLE;

ALTER TABLE risk ADD COLUMN feesTotalSol               DOUBLE;
ALTER TABLE risk ADD COLUMN feesTotalSolDelta          DOUBLE;

ALTER TABLE risk ADD COLUMN riskScoreDelta             DOUBLE;
ALTER TABLE risk ADD COLUMN risksJson                  JSON;


-- =================
-- POSITIONS upgrades
-- =================

ALTER TABLE positions ADD COLUMN entryAmt        DOUBLE;        -- tokens at entry
ALTER TABLE positions ADD COLUMN holdingAmt      DOUBLE;        -- current tokens held
ALTER TABLE positions ADD COLUMN walletId        INT;           -- FK to sc_wallets.wallet_id
ALTER TABLE positions ADD COLUMN walletAlias     VARCHAR(64);   -- denormalized alias
ALTER TABLE positions ADD COLUMN entryPriceSol   DOUBLE;        -- canonical SOL entry price
ALTER TABLE positions ADD COLUMN currentPriceSol DOUBLE;        -- latest SOL price
ALTER TABLE positions ADD COLUMN currentPriceUsd DOUBLE;        -- latest USD price
ALTER TABLE positions ADD COLUMN highestPriceSol DOUBLE;        -- canonical SOL high watermark
ALTER TABLE positions ADD COLUMN source          VARCHAR(64);   -- bot/human origin tag
ALTER TABLE positions ADD COLUMN lastUpdated     BIGINT;        -- last refresh timestamp (ms)