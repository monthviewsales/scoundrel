-- MySQL schema bootstrap generated from adapter definitions

CREATE TABLE IF NOT EXISTS coins (
        mint            VARCHAR(64) PRIMARY KEY,
        symbol          VARCHAR(64),
        name            VARCHAR(255),
        decimals        INT,
        image           TEXT,
        uri             TEXT,
        marketCap       DOUBLE,
        status          ENUM('incomplete','complete','failed','blacklist'),
        lastUpdated     BIGINT,
        lastEvaluated   BIGINT DEFAULT 0,
        price           DOUBLE,
        liquidity       DOUBLE,
        buyScore        DOUBLE
      );

CREATE TABLE IF NOT EXISTS positions (
        coin_mint     VARCHAR(64) PRIMARY KEY,
        trade_uuid    VARCHAR(64),
        entryPrice    DOUBLE,
        entryPriceUSD DOUBLE,
        highestPrice  DOUBLE,
        amount        DOUBLE,
        sl            DOUBLE,
        previousRsi   DOUBLE,
        timestamp     BIGINT,
        lastValidated BIGINT
      );

CREATE TABLE IF NOT EXISTS buys (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        coin_mint VARCHAR(64),
        trade_uuid VARCHAR(64),
        price     DOUBLE,
        priceUsd  DOUBLE,
        qty       DOUBLE,
        timestamp BIGINT,
        txid      VARCHAR(128) UNIQUE,
        fees      BIGINT,
        feesUsd   DOUBLE,
        solUsdPrice DOUBLE,
        slippage DOUBLE,
        priceImpact DOUBLE,
        hiddenTax DOUBLE,
        executionPrice DOUBLE,
        currentPrice DOUBLE
      );

CREATE TABLE IF NOT EXISTS sells (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        coin_mint VARCHAR(64),
        trade_uuid VARCHAR(64),
        price     DOUBLE,
        priceUsd  DOUBLE,
        qty       DOUBLE,
        timestamp BIGINT,
        txid      VARCHAR(128) UNIQUE,
        pnl       DOUBLE,
        pnlPct    DOUBLE,
        fees      BIGINT,
        feesUsd   DOUBLE,
        solUsdPrice DOUBLE,
        slippage DOUBLE,
        priceImpact DOUBLE,
        hiddenTax DOUBLE,
        executionPrice DOUBLE,
        currentPrice DOUBLE
      );

CREATE TABLE IF NOT EXISTS pnl (
        coin_mint          VARCHAR(64) PRIMARY KEY,
        holding            DOUBLE DEFAULT 0,
        held               DOUBLE DEFAULT 0,
        sold               DOUBLE DEFAULT 0,
        sold_usd           DOUBLE DEFAULT 0,
        realized           DOUBLE DEFAULT 0,
        unrealized         DOUBLE DEFAULT 0,
        fees_sol           DOUBLE DEFAULT 0,
        fees_usd           DOUBLE DEFAULT 0,
        total              DOUBLE DEFAULT 0,
        total_sold         DOUBLE DEFAULT 0,
        total_invested     DOUBLE DEFAULT 0,
        average_buy_amount DOUBLE DEFAULT 0,
        current_value      DOUBLE DEFAULT 0,
        cost_basis         DOUBLE DEFAULT 0,
        first_trade_time   BIGINT,
        last_buy_time      BIGINT,
        last_sell_time     BIGINT,
        last_trade_time    BIGINT,
        buy_transactions   INT    DEFAULT 0,
        sell_transactions  INT    DEFAULT 0,
        total_transactions INT    DEFAULT 0,
        lastUpdated        BIGINT
      );

CREATE TABLE IF NOT EXISTS trades (
        trade_uuid VARCHAR(64),
        tx         VARCHAR(128) PRIMARY KEY,
        mint       VARCHAR(64),
        wallet     VARCHAR(64),
        amount     DOUBLE,
        priceUsd   DOUBLE,
        volume     DOUBLE,
        volumeSol  DOUBLE,
        \`type\`   VARCHAR(16),
        \`time\`   BIGINT,
        program    VARCHAR(64),
        pools      TEXT
      );

CREATE TABLE IF NOT EXISTS pending_trade_uuids (
        mint       VARCHAR(64) PRIMARY KEY,
        trade_uuid VARCHAR(64),
        created_at BIGINT
      );

CREATE TABLE IF NOT EXISTS pools (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        coin_mint        VARCHAR(64),
        liquidity_quote  DOUBLE,
        liquidity_usd    DOUBLE,
        price_quote      DOUBLE,
        price_usd        DOUBLE,
        tokenSupply      DOUBLE,
        lpBurn           INT,
        marketCap_quote  DOUBLE,
        marketCap_usd    DOUBLE,
        market           VARCHAR(64),
        quoteToken       VARCHAR(64),
        createdAt        BIGINT,
        lastUpdated      BIGINT,
        UNIQUE KEY unique_coin_market (coin_mint, market)
      );

CREATE TABLE IF NOT EXISTS events (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        coin_mint             VARCHAR(64),
        \`interval\`         VARCHAR(16),
        priceChangePercentage DOUBLE
      );

CREATE TABLE IF NOT EXISTS risk (
        coin_mint VARCHAR(64) PRIMARY KEY,
        rugged    BOOLEAN,
        riskScore INT
      );

CREATE TABLE IF NOT EXISTS chart_data (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        coin_mint  VARCHAR(64),
        timestamp  BIGINT,
        open       DOUBLE,
        close      DOUBLE,
        low        DOUBLE,
        high       DOUBLE,
        volume     DOUBLE
      );

CREATE TABLE IF NOT EXISTS indicators (
        coin_mint  VARCHAR(64) PRIMARY KEY,
        price      DOUBLE,
        rsi        DOUBLE,
        emaShort   DOUBLE,
        emaMedium  DOUBLE,
        macd       DOUBLE,
        bb_upper   DOUBLE,
        bb_middle  DOUBLE,
        bb_lower   DOUBLE,
        bb_pb      DOUBLE,
        trendBias  BOOLEAN
      );

CREATE TABLE IF NOT EXISTS markets (
        name      VARCHAR(64) PRIMARY KEY,
        firstSeen BIGINT,
        lastSeen  BIGINT,
        seenCount INT DEFAULT 0
      );

CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        strategy VARCHAR(64),
        filterBlueprint VARCHAR(64),
        buyBlueprint VARCHAR(64),
        sellBlueprint VARCHAR(64),
        settings JSON,
        startTime BIGINT,
        endTime BIGINT,
        coinsAnalyzed INT,
        coinsPassed INT,
        sellsExecuted INT
      );

CREATE TABLE IF NOT EXISTS evaluations (
        eval_id VARCHAR(64) PRIMARY KEY,
        timestamp BIGINT,
        tokenSymbol VARCHAR(64),
        mint VARCHAR(64),
        strategy VARCHAR(64),
        evalType VARCHAR(16),
        decision BOOLEAN,
        reason TEXT,
        blueprintCatalog JSON,
        blueprintActive JSON,
        gateResults JSON
      );

CREATE TABLE IF NOT EXISTS sc_wallet_analyses (
        analysis_id   VARCHAR(64) PRIMARY KEY,
        wallet        VARCHAR(64) NOT NULL,
        trader_name   VARCHAR(128),
        trade_count   INT DEFAULT 0,
        chart_count   INT DEFAULT 0,
        json_version  VARCHAR(64),
        merged        JSON,
        response_raw  JSON,
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_sc_wallet_analyses_wallet (wallet)
      );

CREATE TABLE IF NOT EXISTS sc_trade_autopsies (
        autopsy_id    VARCHAR(64) PRIMARY KEY,
        wallet        VARCHAR(64) NOT NULL,
        mint          VARCHAR(96) NOT NULL,
        symbol        VARCHAR(64),
        json_version  VARCHAR(64),
        payload       JSON,
        response_raw  JSON,
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_sc_trade_autopsies_wallet (wallet),
        KEY idx_sc_trade_autopsies_mint (mint)
      );

CREATE TABLE IF NOT EXISTS sc_wallets (
        wallet_id       INT AUTO_INCREMENT PRIMARY KEY,
        alias           VARCHAR(255) UNIQUE,
        pubkey          VARCHAR(255) NOT NULL,
        color           VARCHAR(64),
        has_private_key TINYINT(1) DEFAULT 0,
        key_source      VARCHAR(64),
        key_ref         VARCHAR(255),
        created_at      BIGINT,
        updated_at      BIGINT
      );

CREATE TABLE IF NOT EXISTS sc_profiles (
        profile_id  VARCHAR(64) PRIMARY KEY,
        name        VARCHAR(255),
        wallet      VARCHAR(255) NOT NULL,
        profile     JSON,
        source      VARCHAR(255),
        created_at  BIGINT,
        updated_at  BIGINT
      );

CREATE TABLE IF NOT EXISTS sc_asks (
        ask_id         VARCHAR(64) PRIMARY KEY,
        correlation_id VARCHAR(64),
        question       TEXT NOT NULL,
        profile        JSON,
        \`rows\`       JSON,
        model          VARCHAR(128),
        temperature    DOUBLE,
        response_raw   JSON,
        answer         TEXT,
        bullets        JSON,
        actions        JSON,
        created_at     BIGINT
      );

CREATE TABLE IF NOT EXISTS sc_tunes (
        tune_id          VARCHAR(64) PRIMARY KEY,
        correlation_id   VARCHAR(64),
        profile          JSON,
        current_settings JSON,
        model            VARCHAR(128),
        temperature      DOUBLE,
        response_raw     JSON,
        answer           TEXT,
        bullets          JSON,
        actions          JSON,
        changes          JSON,
        patch            JSON,
        risks            JSON,
        rationale        TEXT,
        created_at       BIGINT
      );

CREATE TABLE IF NOT EXISTS sc_job_runs (
        job_run_id   VARCHAR(64) PRIMARY KEY,
        job          VARCHAR(255) NOT NULL,
        context      JSON,
        input        JSON,
        response_raw JSON,
        created_at   BIGINT
      );

CREATE TABLE IF NOT EXISTS sc_wallet_profiles (
        wallet          VARCHAR(255) PRIMARY KEY,
        version         INT,
        technique_json  JSON,
        outcomes_json   JSON,
        heuristics_json JSON,
        enrichment_json JSON,
        updated_at      VARCHAR(32)
      );

CREATE TABLE IF NOT EXISTS sc_wallet_profile_versions (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        wallet          VARCHAR(255),
        version         INT,
        technique_json  JSON,
        outcomes_json   JSON,
        heuristics_json JSON,
        enrichment_json JSON,
        created_at      VARCHAR(32)
      );

CREATE TABLE IF NOT EXISTS sc_wallet_profile_index (
        wallet           VARCHAR(255) PRIMARY KEY,
        style            VARCHAR(255),
        entry_technique  VARCHAR(255),
        win_rate         DOUBLE,
        median_exit_pct  DOUBLE,
        median_hold_mins DOUBLE,
        last_seen_at     VARCHAR(32)
      );

CREATE INDEX idx_coins_status ON coins(status);

CREATE INDEX idx_coins_lastUpdated ON coins(lastUpdated);

CREATE INDEX idx_coins_buyScore ON coins(buyScore);

CREATE INDEX idx_coins_status_buy_lastUpdated ON coins(status, buyScore, lastUpdated);

CREATE INDEX idx_positions_lastValidated ON positions(lastValidated);

CREATE INDEX idx_pools_coin_mint ON pools(coin_mint);

CREATE INDEX idx_trades_mint ON trades(mint);

CREATE INDEX idx_trades_wallet ON trades(wallet);
