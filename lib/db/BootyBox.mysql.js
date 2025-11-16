/**
 * MySQL-backed BootyBox implementation using async/await.
 */

require("dotenv").config();
const mysqlClient = require("./mysql");

/**
 * Minimal env helper for Scoundrel.
 * Reads from process.env with a default.
 */
function getEnv(key, defaultValue) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key];
  }
  return defaultValue;
}

let pool;
let initPromise = null;
const pendingSwaps = new Set();
const tradeUuidMap = new Map();

function requirePool() {
  if (!pool) {
    throw new Error("BootyBox.init() must be called before database helpers.");
  }
  return pool;
}

async function upsertPendingTradeUuid(mint, uuid) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO pending_trade_uuids (mint, trade_uuid, created_at)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE trade_uuid = VALUES(trade_uuid), created_at = VALUES(created_at)`,
    [mint, uuid, Date.now()]
  );
}

async function deletePendingTradeUuid(mint) {
  if (!pool) return;
  await pool.query("DELETE FROM pending_trade_uuids WHERE mint = ?", [mint]);
}

async function ensureTradeUuidCached(mint) {
  if (!mint || tradeUuidMap.has(mint) || !pool) {
    return tradeUuidMap.get(mint) || null;
  }

  let uuid = null;
  const [positionRows] = await pool.query(
    "SELECT trade_uuid FROM positions WHERE coin_mint = ? AND trade_uuid IS NOT NULL",
    [mint]
  );
  if (positionRows?.length && positionRows[0].trade_uuid) {
    uuid = positionRows[0].trade_uuid;
  }
  if (!uuid) {
    const [pendingRows] = await pool.query(
      "SELECT trade_uuid FROM pending_trade_uuids WHERE mint = ? AND trade_uuid IS NOT NULL",
      [mint]
    );
    if (pendingRows?.length && pendingRows[0].trade_uuid) {
      uuid = pendingRows[0].trade_uuid;
    }
  }
  if (uuid) tradeUuidMap.set(mint, uuid);
  return uuid || null;
}

async function setTradeUuid(mint, uuid) {
  if (!mint || !uuid) return;
  tradeUuidMap.set(mint, uuid);
  if (pool) {
    const [result] = await pool.query(
      "UPDATE positions SET trade_uuid = ? WHERE coin_mint = ?",
      [uuid, mint]
    );
    if (result.affectedRows && result.affectedRows > 0) {
      await deletePendingTradeUuid(mint);
    } else {
      await upsertPendingTradeUuid(mint, uuid);
    }
  }
}
function getTradeUuid(mint) {
  return tradeUuidMap.get(mint);
}
async function clearTradeUuid(mint) {
  tradeUuidMap.delete(mint);
  if (pool) {
    await pool.query(
      "UPDATE positions SET trade_uuid = NULL WHERE coin_mint = ?",
      [mint]
    );
    await deletePendingTradeUuid(mint);
  }
}

function normalizeWalletField(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str || str.toLowerCase() === "unknown") return null;
  return str;
}

// MySQL-safe index creation helper
async function ensureIndex(table, indexName, columnsList) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName]
  );
  if (rows.length === 0) {
    await pool.query(`CREATE INDEX ${indexName} ON ${table} (${columnsList})`);
  }
}

// Ensure a column exists, adding it if missing
async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [
    column,
  ]);
  if (rows.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function init() {
  if (pool) {
    return pool;
  }
  if (initPromise) {
    return initPromise;
  }

  const DB_HOST = getEnv("DB_HOST", "localhost");
  const DB_PORT = Number(getEnv("DB_PORT", 3306));
  const DB_NAME = getEnv("DB_NAME", "BewareWF");
  const DB_USER = getEnv("DB_USER", "warlordRoot");

  initPromise = (async () => {
    if (!DB_HOST || !DB_PORT || !DB_NAME || !DB_USER) {
      throw new Error(
        "Missing required MySQL env (DB_HOST, DB_PORT, DB_NAME, DB_USER)"
      );
    }

    pool = mysqlClient.getPool();
    await mysqlClient.ping();

    await pool.query(`
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
    `);

    await pool.query(`
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
    `);

    await ensureColumn("positions", "trade_uuid", "VARCHAR(64)");

    await pool.query(`
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
    `);

    await ensureColumn("buys", "trade_uuid", "VARCHAR(64)");
    await ensureColumn("buys", "solUsdPrice", "DOUBLE");
    await ensureColumn("buys", "slippage", "DOUBLE");
    await ensureColumn("buys", "priceImpact", "DOUBLE");
    await ensureColumn("buys", "hiddenTax", "DOUBLE");
    await ensureColumn("buys", "executionPrice", "DOUBLE");
    await ensureColumn("buys", "currentPrice", "DOUBLE");

    await pool.query(`
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
    `);

    await ensureColumn("sells", "trade_uuid", "VARCHAR(64)");
    await ensureColumn("sells", "solUsdPrice", "DOUBLE");
    await ensureColumn("sells", "slippage", "DOUBLE");
    await ensureColumn("sells", "priceImpact", "DOUBLE");
    await ensureColumn("sells", "hiddenTax", "DOUBLE");
    await ensureColumn("sells", "executionPrice", "DOUBLE");
    await ensureColumn("sells", "currentPrice", "DOUBLE");

    await pool.query(`
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
    `);

    await pool.query(`
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
    `);

    await ensureColumn("trades", "trade_uuid", "VARCHAR(64)");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_trade_uuids (
        mint       VARCHAR(64) PRIMARY KEY,
        trade_uuid VARCHAR(64),
        created_at BIGINT
      );
    `);

    const [uuidRows] = await pool.query(
      "SELECT coin_mint, trade_uuid FROM positions WHERE trade_uuid IS NOT NULL"
    );
    for (const row of uuidRows) {
      tradeUuidMap.set(row.coin_mint, row.trade_uuid);
    }
    const [pendingUuidRows] = await pool.query(
      "SELECT mint, trade_uuid FROM pending_trade_uuids WHERE trade_uuid IS NOT NULL"
    );
    for (const row of pendingUuidRows) {
      if (!tradeUuidMap.has(row.mint)) {
        tradeUuidMap.set(row.mint, row.trade_uuid);
      }
    }

    // Additional tables to match SQLite parity
    await pool.query(`
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
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        coin_mint             VARCHAR(64),
        \`interval\`         VARCHAR(16),
        priceChangePercentage DOUBLE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS risk (
        coin_mint VARCHAR(64) PRIMARY KEY,
        rugged    BOOLEAN,
        riskScore INT
      );
    `);

    await pool.query(`
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
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS indicators (
        coin_mint  VARCHAR(64) PRIMARY KEY,
        price      DOUBLE,
        rsi        DOUBLE,
        macd       DOUBLE,
        bb_upper   DOUBLE,
        bb_middle  DOUBLE,
        bb_lower   DOUBLE,
        bb_pb      DOUBLE,
        trendBias  BOOLEAN
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        name      VARCHAR(64) PRIMARY KEY,
        firstSeen BIGINT,
        lastSeen  BIGINT,
        seenCount INT DEFAULT 0
      );
    `);

    await pool.query(`
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
    `);

    await pool.query(`
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
    `);

    // Helpful indexes
    await ensureIndex("coins", "idx_coins_status", "status");
    await ensureIndex("coins", "idx_coins_lastUpdated", "lastUpdated");
    await ensureIndex("coins", "idx_coins_buyScore", "buyScore");
    await ensureIndex(
      "coins",
      "idx_coins_status_buy_lastUpdated",
      "status, buyScore, lastUpdated"
    );
    await ensureIndex(
      "positions",
      "idx_positions_lastValidated",
      "lastValidated"
    );
    await ensureIndex("pools", "idx_pools_coin_mint", "coin_mint");
    await ensureIndex("trades", "idx_trades_mint", "mint");
    await ensureIndex("trades", "idx_trades_wallet", "wallet");

    console.log(
      `[BootyBox] Connected to MySQL at ${DB_HOST}:${DB_PORT}/${DB_NAME}`
    );
    return pool;
  })();

  try {
    await initPromise;
    return pool;
  } catch (err) {
    console.error(`[BootyBox] MySQL init failed: ${err.message}`);
    pool = undefined;
    initPromise = null;
    throw err;
  }
}

async function addOrUpdateCoin(coin) {
  const now = Date.now();
  // Support both nested and flat coin objects (parity with SQLite impl)
  if (coin && coin.token) {
    coin = {
      ...coin.token,
      pools: coin.pools || [],
      events: coin.events || {},
      risk: coin.risk || {},
      status: coin.status || "incomplete",
      marketCap: coin.pools?.[0]?.marketCap?.usd || 0,
      lastUpdated: now,
    };
  }

  const data = {
    mint: coin.mint,
    symbol: coin.symbol || null,
    name: coin.name || null,
    decimals: coin.decimals || null,
    image: coin.image || null,
    uri: coin.uri || null,
    marketCap: coin.marketCap || null,
    status: coin.status || "complete",
    lastUpdated: coin.lastUpdated || now,
    lastEvaluated: coin.lastEvaluated || 0,
    price: coin.price || null,
    liquidity: coin.liquidity || null,
    buyScore: typeof coin.buyScore === "number" ? coin.buyScore : 0,
  };
  const cols = Object.keys(data).join(",");
  const placeholders = Object.keys(data)
    .map(() => "?")
    .join(",");
  const updates = Object.keys(data)
    .map((k) => `${k}=VALUES(${k})`)
    .join(",");
  await pool.query(
    `INSERT INTO coins (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    Object.values(data)
  );

  // Insert/update pools if provided
  if (Array.isArray(coin.pools)) {
    for (const p of coin.pools) {
      if (!p || typeof p !== "object") continue;
      await pool.query(
        `INSERT INTO pools (
          coin_mint, liquidity_quote, liquidity_usd, price_quote, price_usd, tokenSupply,
          lpBurn, marketCap_quote, marketCap_usd, market, quoteToken, createdAt, lastUpdated
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          liquidity_quote=VALUES(liquidity_quote),
          liquidity_usd=VALUES(liquidity_usd),
          price_quote=VALUES(price_quote),
          price_usd=VALUES(price_usd),
          tokenSupply=VALUES(tokenSupply),
          lpBurn=VALUES(lpBurn),
          marketCap_quote=VALUES(marketCap_quote),
          marketCap_usd=VALUES(marketCap_usd),
          quoteToken=VALUES(quoteToken),
          createdAt=VALUES(createdAt),
          lastUpdated=VALUES(lastUpdated)
        `,
        [
          coin.mint,
          p?.liquidity?.quote ?? null,
          p?.liquidity?.usd ?? null,
          p?.price?.quote ?? null,
          p?.price?.usd ?? null,
          p?.tokenSupply ?? null,
          p?.lpBurn ?? null,
          p?.marketCap?.quote ?? null,
          p?.marketCap?.usd ?? null,
          p?.market ?? null,
          p?.quoteToken ?? null,
          p?.createdAt ?? null,
          now,
        ]
      );
    }
  }
}

async function getCoinByMint(mint) {
  const [rows] = await pool.query("SELECT * FROM coins WHERE mint = ?", [mint]);
  return rows[0] || null;
}

async function updateCoinPriceFields(mint, fields) {
  if (!mint || !fields) return;
  const updates = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    updates.push(`${k} = ?`);
    params.push(v);
  }
  updates.push("lastUpdated = ?");
  params.push(Date.now());
  params.push(mint);
  await pool.query(
    `UPDATE coins SET ${updates.join(", ")} WHERE mint = ?`,
    params
  );
}

async function updateCoinStatus(mint, status) {
  await pool.query(
    "UPDATE coins SET status = ?, lastUpdated = ? WHERE mint = ?",
    [status, Date.now(), mint]
  );
}

async function updateLastEvaluated(mint) {
  await pool.query(
    "UPDATE coins SET lastEvaluated = ?, lastUpdated = ? WHERE mint = ?",
    [Date.now(), Date.now(), mint]
  );
}

let _lastPruneMs = 0;
async function pruneZeroBuyScoreCoins() {
  const now = Date.now();
  // Throttle pruning to at most once every 10 minutes
  if (now - _lastPruneMs < 10 * 60 * 1000) return 0;
  const [result] = await pool.query(
    `DELETE c FROM coins c
     LEFT JOIN positions p ON p.coin_mint = c.mint
     WHERE c.buyScore = 0 AND p.coin_mint IS NULL`
  );
  _lastPruneMs = now;
  return result.affectedRows || 0;
}

async function getCoinCount() {
  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM coins");
  return rows[0].count;
}

async function queryEligibleCoinsForBuy(limit = 100) {
  await pruneZeroBuyScoreCoins();
  const minBuyScore = Number(getEnv("MIN_BUY_SCORE", 0));
  const [rows] = await pool.query(
    `SELECT c.*
     FROM coins c
     WHERE c.status = 'complete'
       AND c.buyScore >= ?
       AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.coin_mint = c.mint)
     ORDER BY c.buyScore DESC, c.lastUpdated ASC
     LIMIT ?`,
    [minBuyScore, limit]
  );
  return rows;
}

async function getOpenPositions() {
  const [rows] = await pool.query(`
    SELECT p.*, c.symbol, c.name, c.decimals, c.image, c.status, c.price AS coin_price
    FROM positions p
    JOIN coins c ON c.mint = p.coin_mint
    WHERE c.status = 'complete'
  `);
  return rows;
}

async function addPosition(pos) {
  const now = Date.now();
  await ensureTradeUuidCached(pos.coin_mint);
  let trade_uuid = pos.trade_uuid || tradeUuidMap.get(pos.coin_mint) || null;
  if (trade_uuid) {
    tradeUuidMap.set(pos.coin_mint, trade_uuid);
    await deletePendingTradeUuid(pos.coin_mint);
  }
  const data = {
    coin_mint: pos.coin_mint,
    trade_uuid,
    entryPrice: pos.entryPrice || 0,
    entryPriceUSD: pos.entryPriceUSD || 0,
    highestPrice: pos.highestPrice || 0,
    amount: pos.amount || 0,
    sl: pos.sl || null,
    previousRsi: pos.previousRsi || null,
    timestamp: pos.timestamp || now,
    lastValidated: pos.lastValidated || now,
  };
  const cols = Object.keys(data).join(",");
  const placeholders = Object.keys(data)
    .map(() => "?")
    .join(",");
  const updateClauses = [
    "trade_uuid=COALESCE(positions.trade_uuid, VALUES(trade_uuid))",
    "entryPrice=VALUES(entryPrice)",
    "entryPriceUSD=VALUES(entryPriceUSD)",
    "highestPrice=GREATEST(positions.highestPrice, VALUES(highestPrice))",
    "amount=VALUES(amount)",
    "sl=VALUES(sl)",
    "previousRsi=VALUES(previousRsi)",
    "timestamp=VALUES(timestamp)",
    "lastValidated=VALUES(lastValidated)",
  ];
  await pool.query(
    `INSERT INTO positions (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClauses.join(
      ", "
    )}`,
    Object.values(data)
  );
}

async function removePosition(mint) {
  await pool.query("DELETE FROM positions WHERE coin_mint = ?", [mint]);
}

async function getBootyByMint(mint) {
  const [rows] = await pool.query(
    "SELECT * FROM positions WHERE coin_mint = ?",
    [mint]
  );
  return rows[0] || null;
}

async function getTokenAmount(mint) {
  const [rows] = await pool.query(
    "SELECT amount FROM positions WHERE coin_mint = ?",
    [mint]
  );
  return rows[0] ? Number(rows[0].amount) : 0;
}

function markPendingSwap(mint) {
  pendingSwaps.add(mint);
}
function clearPendingSwap(mint) {
  pendingSwaps.delete(mint);
}
function getPendingSwapCount() {
  return pendingSwaps.size;
}
function isSwapPending(mint) {
  return pendingSwaps.has(mint);
}

async function getHeartbeatSnapshot(options = {}) {
  const evaluationLookbackMs = Number.isFinite(options.evaluationLookbackMs)
    ? Math.max(0, options.evaluationLookbackMs)
    : 5 * 60 * 1000;

  const snapshot = {
    coinCount: 0,
    openPositions: 0,
    pendingSwapCount: pendingSwaps.size,
    pendingSwapMints: Array.from(pendingSwaps),
    recentEvaluationCount: null,
    evaluationLookbackMs:
      evaluationLookbackMs > 0 ? evaluationLookbackMs : null,
    recentEvaluationBreakdown: null,
    recentBuys: null,
    recentSells: null,
    positionExposure: {
      notionalSol: 0,
      entryCostSol: 0,
      unrealizedPnLSol: 0,
    },
  };

  if (!pool) {
    return snapshot;
  }

  const [[coinRows], [positionRows], [exposureRows]] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM coins"),
    pool.query(`
      SELECT COUNT(*) AS count
      FROM positions p
      JOIN coins c ON c.mint = p.coin_mint
      WHERE c.status = 'complete'
    `),
    pool.query(`
      SELECT
        COALESCE(SUM(p.amount * c.price), 0)       AS notionalSol,
        COALESCE(SUM(p.amount * p.entryPrice), 0) AS entrySol
      FROM positions p
      JOIN coins c ON c.mint = p.coin_mint
      WHERE c.status = 'complete'
    `),
  ]);

  snapshot.coinCount = coinRows?.[0]?.count || 0;
  snapshot.openPositions = positionRows?.[0]?.count || 0;

  const exposureRow = exposureRows?.[0] || {};
  const notionalSol = Number(exposureRow.notionalSol) || 0;
  const entrySol = Number(exposureRow.entrySol) || 0;
  snapshot.positionExposure = {
    notionalSol,
    entryCostSol: entrySol,
    unrealizedPnLSol: notionalSol - entrySol,
  };

  if (evaluationLookbackMs > 0) {
    const since = Date.now() - evaluationLookbackMs;
    const [[evalRows], [evalBreakdownRows], [buyRows], [sellRows]] =
      await Promise.all([
        pool.query(
          "SELECT COUNT(*) AS count FROM evaluations WHERE timestamp >= ?",
          [since]
        ),
        pool.query(
          `
        SELECT decision, COUNT(*) AS count
        FROM evaluations
        WHERE timestamp >= ?
        GROUP BY decision
      `,
          [since]
        ),
        pool.query(
          `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(qty * price), 0)    AS volumeSol,
          COALESCE(SUM(qty * priceUsd), 0) AS volumeUsd,
          COALESCE(SUM(feesUsd), 0)        AS feesUsd
        FROM buys
        WHERE timestamp >= ?
      `,
          [since]
        ),
        pool.query(
          `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(qty * price), 0)    AS volumeSol,
          COALESCE(SUM(qty * priceUsd), 0) AS volumeUsd,
          COALESCE(SUM(pnl), 0)            AS realizedPnl,
          COALESCE(SUM(feesUsd), 0)        AS feesUsd
        FROM sells
        WHERE timestamp >= ?
      `,
          [since]
        ),
      ]);

    snapshot.recentEvaluationCount = evalRows?.[0]?.count || 0;

    const breakdown = { pass: 0, fail: 0 };
    for (const row of evalBreakdownRows || []) {
      const isPass = Number(row.decision) === 1;
      if (isPass) {
        breakdown.pass += Number(row.count) || 0;
      } else {
        breakdown.fail += Number(row.count) || 0;
      }
    }
    snapshot.recentEvaluationBreakdown = breakdown;

    const buyAgg = buyRows?.[0] || {};
    snapshot.recentBuys = {
      count: Number(buyAgg.count) || 0,
      volumeSol: Number(buyAgg.volumeSol) || 0,
      volumeUsd: Number(buyAgg.volumeUsd) || 0,
      feesUsd: Number(buyAgg.feesUsd) || 0,
    };

    const sellAgg = sellRows?.[0] || {};
    snapshot.recentSells = {
      count: Number(sellAgg.count) || 0,
      volumeSol: Number(sellAgg.volumeSol) || 0,
      volumeUsd: Number(sellAgg.volumeUsd) || 0,
      realizedPnl: Number(sellAgg.realizedPnl) || 0,
      feesUsd: Number(sellAgg.feesUsd) || 0,
    };
  }

  return snapshot;
}

async function updateHighestPrice(mint, price) {
  const [rows] = await pool.query(
    "SELECT highestPrice FROM positions WHERE coin_mint = ?",
    [mint]
  );
  if (!rows.length) {
    console.warn(
      `[BootyBox] Tried to update highestPrice for unknown mint ${mint}`
    );
    return null;
  }
  const current = rows[0].highestPrice || 0;
  if (price > current) {
    await pool.query(
      "UPDATE positions SET highestPrice = ? WHERE coin_mint = ?",
      [price, mint]
    );
    console.debug(`[BootyBox] Updated highestPrice for ${mint} → ${price}`);
    return price;
  }
  console.debug(
    `[BootyBox] Skipped highestPrice update for ${mint} — new price ${price} not higher than DB-stored ${current}`
  );
  return current;
}

async function getHighestPriceByMint(mint) {
  const [rows] = await pool.query(
    "SELECT highestPrice FROM positions WHERE coin_mint = ?",
    [mint]
  );
  return rows.length ? rows[0].highestPrice : null;
}

async function updatePreviousRsi(mint, rsi) {
  await pool.query("UPDATE positions SET previousRsi = ? WHERE coin_mint = ?", [
    rsi,
    mint,
  ]);
  console.debug(`[BootyBox] Stored previous RSI for ${mint}: ${rsi}`);
}

async function logBuy(data) {
  await ensureTradeUuidCached(data.coin_mint);
  let trade_uuid = data.trade_uuid || tradeUuidMap.get(data.coin_mint) || null;
  if (trade_uuid) {
    tradeUuidMap.set(data.coin_mint, trade_uuid);
    await deletePendingTradeUuid(data.coin_mint);
  }
  await pool.query(
    `INSERT IGNORE INTO buys (coin_mint, trade_uuid, price, priceUsd, qty, timestamp, txid, fees, feesUsd, solUsdPrice, slippage, priceImpact, hiddenTax, executionPrice, currentPrice) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      data.coin_mint,
      trade_uuid,
      data.price,
      data.priceUsd,
      data.qty,
      data.timestamp || Date.now(),
      data.txid,
      data.fees || 0,
      data.feesUsd || 0,
      data.solUsdPrice ?? null,
      data.slippage ?? null,
      data.priceImpact ?? null,
      data.hiddenTax ?? null,
      data.executionPrice ?? null,
      data.currentPrice ?? null,
    ]
  );
  // const { publicKey } = getConfig();
  const wallet = data.wallet || null;
  await insertTrades(data.coin_mint, wallet, [
    {
      trade_uuid,
      tx: data.txid,
      wallet,
      amount: data.qty,
      priceUsd: data.priceUsd,
      volume: data.qty * data.priceUsd,
      volumeSol: data.qty * data.price,
      type: "buy",
      time: data.timestamp || Date.now(),
      program: data.program || "swap",
      pools: Array.isArray(data.pools) ? data.pools : [],
    },
  ]);
}

async function logSell(data) {
  await ensureTradeUuidCached(data.coin_mint);
  let trade_uuid = data.trade_uuid || tradeUuidMap.get(data.coin_mint) || null;
  if (trade_uuid) {
    tradeUuidMap.set(data.coin_mint, trade_uuid);
    await deletePendingTradeUuid(data.coin_mint);
  }
  await pool.query(
    `INSERT IGNORE INTO sells (coin_mint, trade_uuid, price, priceUsd, qty, timestamp, txid, pnl, pnlPct, fees, feesUsd, solUsdPrice, slippage, priceImpact, hiddenTax, executionPrice, currentPrice) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      data.coin_mint,
      trade_uuid,
      data.price,
      data.priceUsd,
      data.qty,
      data.timestamp || Date.now(),
      data.txid,
      data.pnl || 0,
      data.pnlPct || 0,
      data.fees || 0,
      data.feesUsd || 0,
      data.solUsdPrice ?? null,
      data.slippage ?? null,
      data.priceImpact ?? null,
      data.hiddenTax ?? null,
      data.executionPrice ?? null,
      data.currentPrice ?? null,
    ]
  );

  // const { publicKey } = getConfig();
  const wallet = data.wallet || null;
  await insertTrades(data.coin_mint, wallet, [
    {
      trade_uuid,
      tx: data.txid,
      wallet,
      amount: data.qty,
      priceUsd: data.priceUsd,
      volume: data.qty * data.priceUsd,
      volumeSol: data.qty * data.price,
      type: "sell",
      time: data.timestamp || Date.now(),
      program: data.program || "swap",
      pools: Array.isArray(data.pools) ? data.pools : [],
    },
  ]);
  await clearTradeUuid(data.coin_mint);
}

async function getLatestBuyByMint(mint) {
  const [rows] = await pool.query(
    "SELECT * FROM buys WHERE coin_mint = ? ORDER BY timestamp DESC LIMIT 1",
    [mint]
  );
  return rows[0] || null;
}

async function getLatestSellByMint(mint) {
  const [rows] = await pool.query(
    "SELECT * FROM sells WHERE coin_mint = ? ORDER BY timestamp DESC LIMIT 1",
    [mint]
  );
  return rows[0] || null;
}

async function logEvaluation(e) {
  await pool.query(
    `INSERT INTO evaluations (eval_id, timestamp, tokenSymbol, mint, strategy, evalType, decision, reason, blueprintCatalog, blueprintActive, gateResults)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      e.evalId,
      e.timestamp || Date.now(),
      e.tokenSymbol,
      e.mint,
      e.strategy,
      e.evalType,
      e.decision ? 1 : 0,
      e.reason || "",
      JSON.stringify(e.blueprintCatalog || {}),
      JSON.stringify(e.blueprintActive || {}),
      JSON.stringify(e.gateResults || {}),
    ]
  );
}

async function updatePnL(mint, pnlData) {
  const now = Date.now();
  // Whitelist known columns and normalize aliases
  const allowed = new Set([
    "holding",
    "held",
    "sold",
    "sold_usd",
    "realized",
    "unrealized",
    "fees_sol",
    "fees_usd",
    "total",
    "total_sold",
    "total_invested",
    "average_buy_amount",
    "current_value",
    "cost_basis",
    "first_trade_time",
    "last_buy_time",
    "last_sell_time",
    "last_trade_time",
    "buy_transactions",
    "sell_transactions",
    "total_transactions",
  ]);
  const normalized = { ...pnlData };
  // Map legacy/synonym key
  if (normalized.first_buy_time && !normalized.first_trade_time) {
    normalized.first_trade_time = normalized.first_buy_time;
    delete normalized.first_buy_time;
  }
  // Build filtered data object
  const data = { coin_mint: mint, lastUpdated: now };
  for (const [k, v] of Object.entries(normalized)) {
    if (allowed.has(k)) data[k] = v;
  }
  const cols = Object.keys(data).join(",");
  const placeholders = Object.keys(data)
    .map(() => "?")
    .join(",");
  const updates = Object.keys(data)
    .map((k) => `${k}=VALUES(${k})`)
    .join(",");
  await pool.query(
    `INSERT INTO pnl (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    Object.values(data)
  );
  await pool.query("UPDATE coins SET lastUpdated = ? WHERE mint = ?", [
    now,
    mint,
  ]);
  await pool.query(
    "UPDATE positions SET lastValidated = ? WHERE coin_mint = ?",
    [now, mint]
  );
}

async function insertTrades(mint, wallet, trades) {
  if (!Array.isArray(trades) || trades.length === 0 || !pool) return;

  await ensureTradeUuidCached(mint);
  const fallbackUuid = tradeUuidMap.get(mint) || null;
  // const { publicKey } = getConfig();
  const fallbackWallet = normalizeWalletField(wallet);

  const values = [];
  for (const t of trades) {
    const tradeUuid =
      t.trade_uuid || fallbackUuid || tradeUuidMap.get(mint) || null;
    if (tradeUuid) {
      tradeUuidMap.set(mint, tradeUuid);
      await deletePendingTradeUuid(mint);
    }
    const walletValue =
      normalizeWalletField(t.wallet) || fallbackWallet || null;
    values.push(
      tradeUuid,
      t.tx,
      mint,
      walletValue,
      Number.isFinite(t.amount) ? t.amount : null,
      Number.isFinite(t.priceUsd) ? t.priceUsd : null,
      Number.isFinite(t.volume) ? t.volume : null,
      Number.isFinite(t.volumeSol) ? t.volumeSol : null,
      t.type || null,
      t.time || null,
      t.program || null,
      JSON.stringify(Array.isArray(t.pools) ? t.pools : [])
    );
  }

  const placeholders = trades.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
  await pool.query(
    `INSERT INTO trades (trade_uuid, tx, mint, wallet, amount, priceUsd, volume, volumeSol, type, time, program, pools)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       trade_uuid = COALESCE(VALUES(trade_uuid), trade_uuid),
       wallet = COALESCE(VALUES(wallet), wallet),
       amount = COALESCE(VALUES(amount), amount),
       priceUsd = COALESCE(VALUES(priceUsd), priceUsd),
       volume = COALESCE(VALUES(volume), volume),
       volumeSol = COALESCE(VALUES(volumeSol), volumeSol),
       type = COALESCE(VALUES(type), type),
       time = COALESCE(VALUES(time), time),
       program = COALESCE(VALUES(program), program),
       pools = COALESCE(VALUES(pools), pools)`,
    values
  );
}

async function upsertMarket(marketName) {
  if (!marketName || typeof marketName !== "string") return;
  const now = Date.now();
  await pool.query(
    `INSERT INTO markets (name, firstSeen, lastSeen, seenCount)
     VALUES (?,?,?,1)
     ON DUPLICATE KEY UPDATE lastSeen=VALUES(lastSeen), seenCount=seenCount+1`,
    [marketName, now, now]
  );
}

async function cleanupStaleAndResetBuyScores(hours = 2) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  // 1) Delete coins older than cutoff, excluding those in open positions or with PnL
  await pool.query(
    `DELETE FROM coins
     WHERE lastUpdated < ?
       AND lastEvaluated < ?
       AND mint NOT IN (SELECT coin_mint FROM positions)
       AND mint NOT IN (SELECT coin_mint FROM pnl)`,
    [cutoff, cutoff]
  );
  // 1a) Delete pools where coin no longer exists
  await pool.query(
    `DELETE FROM pools WHERE coin_mint NOT IN (SELECT mint FROM coins)`
  );
  // 2) Reset buyScore
  await pool.query(`UPDATE coins SET buyScore = 0`);
  console.debug(
    `[BootyBox] cleanupStaleAndResetBuyScores: pruned stale coins and reset buyScore`
  );
}

async function startSession(info) {
  const [res] = await pool.query(
    "INSERT INTO sessions (strategy, filterBlueprint, buyBlueprint, sellBlueprint, settings, startTime) VALUES (?,?,?,?,?,?)",
    [
      info.strategy,
      info.filterBlueprint,
      info.buyBlueprint,
      info.sellBlueprint,
      JSON.stringify(info.settings || {}),
      Date.now(),
    ]
  );
  return res.insertId;
}

async function endSession(id, metrics = {}) {
  await pool.query(
    "UPDATE sessions SET endTime=?, coinsAnalyzed=?, coinsPassed=?, sellsExecuted=? WHERE id=?",
    [
      Date.now(),
      metrics.coinsAnalyzed || 0,
      metrics.coinsPassed || 0,
      metrics.sellsExecuted || 0,
      id,
    ]
  );
}

async function updateSessionStats(id, metrics = {}) {
  if (!id || !pool) return;
  const fields = [];
  const values = [];
  const push = (column, value) => {
    if (Number.isFinite(value)) {
      fields.push(`${column} = ?`);
      values.push(Math.max(0, Math.round(value)));
    }
  };

  push("coinsAnalyzed", metrics.coinsAnalyzed);
  push("coinsPassed", metrics.coinsPassed);
  push("sellsExecuted", metrics.sellsExecuted);

  if (!fields.length) return;

  values.push(id);
  await pool.query(
    `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`,
    values
  );
}

async function getPnLAggregates() {
  if (!pool) return { buys: {}, sells: {} };

  const [buyRows] = await pool.query(`
    SELECT
      COALESCE(SUM(priceUsd * qty), 0)   AS totalCostUsd,
      COALESCE(SUM(qty), 0)              AS totalTokens,
      COALESCE(SUM(feesUsd), 0)          AS totalFeesUsd,
      COUNT(*)                           AS count
    FROM buys
  `);

  const [sellRows] = await pool.query(`
    SELECT
      COALESCE(SUM(pnl), 0)             AS realizedUsd,
      COALESCE(SUM(priceUsd * qty), 0)  AS grossProceedsUsd,
      COALESCE(SUM(feesUsd), 0)         AS totalFeesUsd,
      COUNT(*)                          AS count
    FROM sells
  `);

  return {
    buys: buyRows[0] || {
      totalCostUsd: 0,
      totalTokens: 0,
      totalFeesUsd: 0,
      count: 0,
    },
    sells: sellRows[0] || {
      realizedUsd: 0,
      grossProceedsUsd: 0,
      totalFeesUsd: 0,
      count: 0,
    },
  };
}

function mapWalletRow(row) {
  if (!row) return null;
  return {
    walletId: row.walletId,
    alias: row.alias,
    pubkey: row.pubkey,
    color: row.color,
    hasPrivateKey: !!row.hasPrivateKey,
    keySource: row.keySource,
    keyRef: row.keyRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listWarchestWallets() {
  const activePool = requirePool();
  const [rows] = await activePool.query(
    `SELECT
       wallet_id      AS walletId,
       alias,
       pubkey,
       color,
       has_private_key AS hasPrivateKey,
       key_source      AS keySource,
       key_ref         AS keyRef,
       created_at      AS createdAt,
       updated_at      AS updatedAt
     FROM sc_wallets
     ORDER BY alias ASC`
  );
  return (rows || []).map(mapWalletRow);
}

async function getWarchestWalletByAlias(alias) {
  if (!alias) return null;
  const activePool = requirePool();
  const [rows] = await activePool.query(
    `SELECT
       wallet_id      AS walletId,
       alias,
       pubkey,
       color,
       has_private_key AS hasPrivateKey,
       key_source      AS keySource,
       key_ref         AS keyRef,
       created_at      AS createdAt,
       updated_at      AS updatedAt
     FROM sc_wallets
     WHERE alias = ?
     LIMIT 1`,
    [alias]
  );
  return rows?.length ? mapWalletRow(rows[0]) : null;
}

async function insertWarchestWallet(record) {
  if (!record || !record.alias || !record.pubkey) {
    throw new Error(
      "insertWarchestWallet: alias and pubkey are required fields."
    );
  }
  const activePool = requirePool();
  const columns = [
    "alias",
    "pubkey",
    "color",
    "has_private_key",
    "key_source",
    "key_ref",
  ];
  const values = [
    record.alias,
    record.pubkey,
    record.color ?? null,
    record.hasPrivateKey ? 1 : 0,
    record.keySource || "none",
    record.keyRef ?? null,
  ];
  if (record.walletId) {
    columns.unshift("wallet_id");
    values.unshift(record.walletId);
  }
  const placeholders = columns.map(() => "?").join(", ");
  await activePool.query(
    `INSERT INTO sc_wallets (${columns.join(", ")}) VALUES (${placeholders})`,
    values
  );
  return getWarchestWalletByAlias(record.alias);
}

async function updateWarchestWalletColor(alias, color) {
  if (!alias) return false;
  const activePool = requirePool();
  const [result] = await activePool.query(
    "UPDATE sc_wallets SET color = ? WHERE alias = ?",
    [color, alias]
  );
  return Boolean(result?.affectedRows);
}

async function deleteWarchestWallet(alias) {
  if (!alias) return false;
  const activePool = requirePool();
  const [result] = await activePool.query(
    "DELETE FROM sc_wallets WHERE alias = ?",
    [alias]
  );
  return Boolean(result?.affectedRows);
}

async function upsertProfileSnapshot({
  profileId,
  name,
  wallet,
  profile,
  source,
}) {
  if (!profileId || !wallet) {
    throw new Error("upsertProfileSnapshot: profileId and wallet required");
  }
  const activePool = requirePool();
  const serialized =
    typeof profile === "string" ? profile : JSON.stringify(profile || null);
  await activePool.query(
    `INSERT INTO sc_profiles (
       profile_id, name, wallet, profile, source
     ) VALUES (
       ?, ?, ?, CAST(? AS JSON), ?
     )
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       wallet = VALUES(wallet),
       profile = VALUES(profile),
       source = VALUES(source)`,
    [profileId, name || wallet, wallet, serialized, source || null]
  );
}

async function recordWalletAnalysis({
  analysisId,
  wallet,
  traderName,
  tradeCount,
  chartCount,
  merged,
  responseRaw,
}) {
  if (!analysisId || !wallet) {
    throw new Error("recordWalletAnalysis: analysisId and wallet required");
  }
  const activePool = requirePool();
  await activePool.query(
    `INSERT INTO sc_wallet_analyses (
       analysis_id,
       wallet,
       trader_name,
       trade_count,
       chart_count,
       merged,
       response_raw
     ) VALUES (
       ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON)
     )`,
    [
      analysisId,
      wallet,
      traderName || null,
      Number.isFinite(tradeCount) ? tradeCount : 0,
      Number.isFinite(chartCount) ? chartCount : 0,
      JSON.stringify(merged ?? null),
      JSON.stringify(responseRaw ?? null),
    ]
  );
}

async function recordAsk({
  askId,
  correlationId,
  question,
  profile,
  rows,
  model,
  temperature,
  responseRaw,
  answer,
  bullets,
  actions,
}) {
  if (!askId || !question) {
    throw new Error("recordAsk: askId and question are required");
  }
  const activePool = requirePool();
  await activePool.query(
    `INSERT INTO sc_asks (
       ask_id,
       correlation_id,
       question,
       profile,
       \`rows\`,
       model,
       temperature,
       response_raw,
       answer,
       bullets,
       actions
     ) VALUES (
       ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON)
     )`,
    [
      askId,
      correlationId || askId,
      question,
      profile ? JSON.stringify(profile) : null,
      rows ? JSON.stringify(rows) : null,
      model || null,
      typeof temperature === "number" ? temperature : null,
      JSON.stringify(responseRaw ?? null),
      answer || "",
      JSON.stringify(Array.isArray(bullets) ? bullets : []),
      JSON.stringify(Array.isArray(actions) ? actions : []),
    ]
  );
}

async function recordTune({
  tuneId,
  correlationId,
  profile,
  currentSettings,
  model,
  temperature,
  responseRaw,
  answer,
  bullets,
  actions,
  changes,
  patch,
  risks,
  rationale,
}) {
  if (!tuneId) {
    throw new Error("recordTune: tuneId is required");
  }
  const activePool = requirePool();
  await activePool.query(
    `INSERT INTO sc_tunes (
       tune_id,
       correlation_id,
       profile,
       current_settings,
       model,
       temperature,
       response_raw,
       answer,
       bullets,
       actions,
       changes,
       patch,
       risks,
       rationale
     ) VALUES (
       ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?
     )`,
    [
      tuneId,
      correlationId || tuneId,
      profile ? JSON.stringify(profile) : null,
      currentSettings ? JSON.stringify(currentSettings) : null,
      model || null,
      typeof temperature === "number" ? temperature : null,
      JSON.stringify(responseRaw ?? null),
      answer || "",
      JSON.stringify(Array.isArray(bullets) ? bullets : []),
      JSON.stringify(Array.isArray(actions) ? actions : []),
      JSON.stringify(changes && typeof changes === "object" ? changes : {}),
      JSON.stringify(Array.isArray(patch) ? patch : []),
      JSON.stringify(Array.isArray(risks) ? risks : []),
      typeof rationale === "string" ? rationale : "",
    ]
  );
}

async function recordJobRun({
  jobRunId,
  job,
  context,
  input,
  responseRaw,
}) {
  if (!jobRunId || !job) {
    throw new Error("recordJobRun: jobRunId and job are required");
  }
  const activePool = requirePool();
  await activePool.query(
    `INSERT INTO sc_job_runs (
       job_run_id,
       job,
       context,
       input,
       response_raw
     ) VALUES (
       ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON)
     )`,
    [
      jobRunId,
      job,
      context != null ? JSON.stringify(context) : null,
      JSON.stringify(input ?? null),
      JSON.stringify(responseRaw ?? null),
    ]
  );
}

const profileJson = (value) =>
  value == null ? null : JSON.stringify(value);

function sqlNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

async function getLatestWalletProfileVersion(wallet) {
  if (!wallet) return 0;
  const activePool = requirePool();
  const [rows] = await activePool.query(
    "SELECT version FROM sc_wallet_profiles WHERE wallet = ? LIMIT 1",
    [wallet]
  );
  if (!rows || !rows.length) return 0;
  const raw = Number(rows[0].version);
  return Number.isFinite(raw) ? raw : 0;
}

async function persistWalletProfileArtifacts({
  wallet,
  technique,
  outcomes,
  heuristics,
  enrichment,
}) {
  if (!wallet) {
    throw new Error("persistWalletProfileArtifacts: wallet is required");
  }
  const activePool = requirePool();
  const updatedAt = sqlNow();
  const version = (await getLatestWalletProfileVersion(wallet)) + 1;

  const techniqueJson = profileJson(technique);
  const outcomesJson = profileJson(outcomes);
  const heuristicsJson = profileJson(heuristics);
  const enrichmentJson = profileJson(enrichment);

  await activePool.query(
    `INSERT INTO sc_wallet_profiles
       (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       version = VALUES(version),
       technique_json = VALUES(technique_json),
       outcomes_json = VALUES(outcomes_json),
       heuristics_json = VALUES(heuristics_json),
       enrichment_json = VALUES(enrichment_json),
       updated_at = VALUES(updated_at)`,
    [
      wallet,
      version,
      techniqueJson,
      outcomesJson,
      heuristicsJson,
      enrichmentJson,
      updatedAt,
    ]
  );

  await activePool.query(
    `INSERT INTO sc_wallet_profile_versions
       (wallet, version, technique_json, outcomes_json, heuristics_json, enrichment_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      wallet,
      version,
      techniqueJson,
      outcomesJson,
      heuristicsJson,
      enrichmentJson,
      updatedAt,
    ]
  );

  const style = technique?.style || null;
  const entryTech = technique?.entryTechnique || null;
  const winRate =
    typeof outcomes?.winRate === "number" ? outcomes.winRate : null;
  const medianExitPct =
    outcomes?.medianExitPct != null ? outcomes.medianExitPct : null;
  const medianHoldMins =
    outcomes?.medianHoldMins != null ? outcomes.medianHoldMins : null;

  await activePool.query(
    `INSERT INTO sc_wallet_profile_index
       (wallet, style, entry_technique, win_rate, median_exit_pct, median_hold_mins, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       style = VALUES(style),
       entry_technique = VALUES(entry_technique),
       win_rate = VALUES(win_rate),
       median_exit_pct = VALUES(median_exit_pct),
       median_hold_mins = VALUES(median_hold_mins),
       last_seen_at = VALUES(last_seen_at)`,
    [
      wallet,
      style,
      entryTech,
      winRate,
      medianExitPct,
      medianHoldMins,
      updatedAt,
    ]
  );

  return { wallet, version };
}

const BootyBox = {
  init,
  ping: () => mysqlClient.ping(),
  close: () => mysqlClient.close(),
  engine: "mysql",
  addOrUpdateCoin,
  getCoinByMint,
  updateCoinPriceFields,
  updateCoinStatus,
  updateLastEvaluated,
  pruneZeroBuyScoreCoins,
  getCoinCount,
  queryEligibleCoinsForBuy,
  getOpenPositions,
  addPosition,
  removePosition,
  getBootyByMint,
  getTokenAmount,
  markPendingSwap,
  clearPendingSwap,
  getPendingSwapCount,
  isSwapPending,
  async bulkResyncPositions(positions) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = Date.now();
      for (const pos of positions || []) {
        await ensureTradeUuidCached(pos.coin_mint);
        let trade_uuid =
          pos.trade_uuid || tradeUuidMap.get(pos.coin_mint) || null;
        if (trade_uuid) {
          tradeUuidMap.set(pos.coin_mint, trade_uuid);
          await deletePendingTradeUuid(pos.coin_mint);
        }
        await conn.query(
          `INSERT INTO positions (coin_mint, trade_uuid, entryPrice, entryPriceUSD, highestPrice, amount, sl, previousRsi, timestamp, lastValidated)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             entryPrice=VALUES(entryPrice),
             entryPriceUSD=VALUES(entryPriceUSD),
             highestPrice=GREATEST(positions.highestPrice, VALUES(highestPrice)),
             amount=VALUES(amount),
             sl=VALUES(sl),
             timestamp=VALUES(timestamp),
             lastValidated=VALUES(lastValidated)`,
          [
            pos.coin_mint,
            trade_uuid,
            pos.entryPrice || 0,
            pos.entryPriceUSD || 0,
            pos.highestPrice || 0,
            pos.amount || 0,
            pos.sl || null,
            pos.previousRsi || null,
            pos.timestamp || now,
            pos.lastValidated || now,
          ]
        );
      }
      // Remove stale positions not in live set
      if (!positions || positions.length === 0) {
        await conn.query("DELETE FROM positions");
      } else {
        const mints = positions.map((p) => p.coin_mint);
        const placeholders = mints.map(() => "?").join(",");
        await conn.query(
          `DELETE FROM positions WHERE coin_mint NOT IN (${placeholders})`,
          mints
        );
      }
      await conn.commit();
    } catch (e) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.warn(`[BootyBox] Rollback failed: ${rollbackErr.message}`);
      }
      throw e;
    } finally {
      conn.release();
    }
  },
  updateHighestPrice,
  getHighestPriceByMint,
  updatePreviousRsi,
  logBuy,
  logSell,
  getLatestBuyByMint,
  getLatestSellByMint,
  logEvaluation,
  updatePnL,
  insertTrades,
  upsertMarket,
  cleanupStaleAndResetBuyScores,
  startSession,
  endSession,
  updateSessionStats,
  getPnLAggregates,
  getHeartbeatSnapshot,
  setTradeUuid,
  getTradeUuid,
  clearTradeUuid,
  listWarchestWallets,
  getWarchestWalletByAlias,
  insertWarchestWallet,
  updateWarchestWalletColor,
  deleteWarchestWallet,
  upsertProfileSnapshot,
  recordWalletAnalysis,
  recordAsk,
  recordTune,
  recordJobRun,
  getLatestWalletProfileVersion,
  persistWalletProfileArtifacts,
};

module.exports = BootyBox;
