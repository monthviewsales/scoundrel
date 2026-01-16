'use strict';

const fs = require('fs');
const pathModule = require('path');

/**
 * Minimal migration runner for BootyBox (SQLite only).
 *
 * This is intentionally dumb and side-effect free:
 *  - The host app constructs the SQLite connection.
 *  - We discover *.sql files in migrations/sqlite, run them in order, and
 *    record which ones have been applied.
 */
function runSqliteMigrations(sqlite, logger) {
  if (!sqlite) {
    logger.warn?.('[BootyBox:migrations] SQLite db not provided, skipping migrations');
    return;
  }

  const migrationsDir = pathModule.join(__dirname, 'sqlite');
  if (!fs.existsSync(migrationsDir)) {
    logger.info?.('[BootyBox:migrations] No SQLite migrations directory found, skipping', {
      dir: migrationsDir,
    });
    return;
  }

  logger.info?.('[BootyBox:migrations] Preparing SQLite migrations table');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bootybox_migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = sqlite.prepare('SELECT name FROM bootybox_migrations').all();
  const applied = new Set(appliedRows.map((r) => r.name));

  const legacyAppliedNames = new Map([
    ['001_bootstrap_legacy.sqlite.sql', ['bootstrap.sqlite.sql', 'sqlite.sql', '001_bootstrap.sqlite.sql']],
    ['002_schema_upgrade.sqlite.sql', ['schema_upgrade.sqlite.sql', '002_schema_upgrade_legacy.sqlite.sql']],
  ]);

  for (const [currentName, aliases] of legacyAppliedNames) {
    if (!applied.has(currentName) && aliases.some((alias) => applied.has(alias))) {
      applied.add(currentName);
    }
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insertStmt = sqlite.prepare(
    'INSERT INTO bootybox_migrations (name, applied_at) VALUES (?, ?)'
  );

  const shouldSkipMigration = (file) => {
    if (file === '011_sc_wallets_strategy.sqlite.sql') {
      try {
        const cols = sqlite.prepare('PRAGMA table_info(sc_wallets)').all();
        if (!cols || cols.length === 0) return false;
        const names = new Set(cols.map((col) => col.name));
        return names.has('strategy');
      } catch (err) {
        logger.debug?.(
          `[BootyBox:migrations] Unable to inspect sc_wallets for ${file}: ${err.message}`
        );
        return false;
      }
    }

    if (file === '014_scoundrel_runtime_tables.sqlite.sql') {
      try {
        const tables = ['sc_trades', 'sc_positions', 'sc_sessions', 'sc_pnl', 'sc_pnl_positions'];
        const placeholders = tables.map(() => '?').join(',');
        const rows = sqlite
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`
          )
          .all(...tables);
        return rows.length === tables.length;
      } catch (err) {
        logger.debug?.(
          `[BootyBox:migrations] Unable to inspect runtime tables for ${file}: ${err.message}`
        );
        return false;
      }
    }

    return false;
  };

  const tableExists = (sqliteDb, table) =>
    Boolean(
      sqliteDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table)
    );

  const ensureColumn = (sqliteDb, table, column, definition) => {
    if (!tableExists(sqliteDb, table)) return;
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((col) => col.name === column)) return;
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  const customMigrations = {
    '002_schema_upgrade.sqlite.sql': (sqliteDb) => {
      const coinsColumns = [
        ['priceSol', 'REAL'],
        ['priceUsd', 'REAL'],
        ['liquiditySol', 'REAL'],
        ['liquidityUsd', 'REAL'],
        ['marketCapSol', 'REAL'],
        ['marketCapUsd', 'REAL'],
        ['tokenCreatedAt', 'INTEGER'],
        ['firstSeenAt', 'INTEGER'],
        ['strictSocials', 'TEXT'],
      ];
      coinsColumns.forEach(([column, definition]) =>
        ensureColumn(sqliteDb, 'coins', column, definition)
      );

      const poolsColumns = [
        ['txns_buys', 'INTEGER'],
        ['txns_sells', 'INTEGER'],
        ['txns_total', 'INTEGER'],
        ['volume_quote', 'REAL'],
        ['volume24h_quote', 'REAL'],
        ['deployer', 'TEXT'],
      ];
      poolsColumns.forEach(([column, definition]) =>
        ensureColumn(sqliteDb, 'pools', column, definition)
      );

      const eventsColumns = [
        ['insertedAt', 'INTEGER'],
        ['previousUpdatedAt', 'INTEGER'],
        ['updatedAt', 'INTEGER'],
        ['priceChangePercentageDelta', 'REAL'],
        ['volumeSol', 'REAL'],
        ['volumeSolDelta', 'REAL'],
        ['volumeUsd', 'REAL'],
        ['volumeUsdDelta', 'REAL'],
        ['buysCount', 'INTEGER'],
        ['buysCountDelta', 'INTEGER'],
        ['sellsCount', 'INTEGER'],
        ['sellsCountDelta', 'INTEGER'],
        ['txnsCount', 'INTEGER'],
        ['txnsCountDelta', 'INTEGER'],
        ['holdersCount', 'INTEGER'],
        ['holdersCountDelta', 'INTEGER'],
      ];
      eventsColumns.forEach(([column, definition]) =>
        ensureColumn(sqliteDb, 'events', column, definition)
      );

      const riskColumns = [
        ['insertedAt', 'INTEGER'],
        ['previousUpdatedAt', 'INTEGER'],
        ['updatedAt', 'INTEGER'],
        ['snipersCount', 'INTEGER'],
        ['snipersTotalBalance', 'REAL'],
        ['snipersTotalPercent', 'REAL'],
        ['snipersCountDelta', 'INTEGER'],
        ['snipersTotalBalanceDelta', 'REAL'],
        ['snipersTotalPercentDelta', 'REAL'],
        ['insidersCount', 'INTEGER'],
        ['insidersTotalBalance', 'REAL'],
        ['insidersTotalPercent', 'REAL'],
        ['insidersCountDelta', 'INTEGER'],
        ['insidersTotalBalanceDelta', 'REAL'],
        ['insidersTotalPercentDelta', 'REAL'],
        ['top10Percent', 'REAL'],
        ['top10PercentDelta', 'REAL'],
        ['devPercent', 'REAL'],
        ['devPercentDelta', 'REAL'],
        ['devAmountTokens', 'REAL'],
        ['devAmountTokensDelta', 'REAL'],
        ['feesTotalSol', 'REAL'],
        ['feesTotalSolDelta', 'REAL'],
        ['riskScoreDelta', 'REAL'],
        ['risksJson', 'TEXT'],
      ];
      riskColumns.forEach(([column, definition]) =>
        ensureColumn(sqliteDb, 'risk', column, definition)
      );

      const positionColumns = [
        ['entryAmt', 'REAL'],
        ['holdingAmt', 'REAL'],
        ['walletId', 'INTEGER'],
        ['walletAlias', 'TEXT'],
        ['entryPriceSol', 'REAL'],
        ['currentPriceSol', 'REAL'],
        ['currentPriceUsd', 'REAL'],
        ['highestPriceSol', 'REAL'],
        ['source', 'TEXT'],
        ['lastUpdated', 'INTEGER'],
      ];
      positionColumns.forEach(([column, definition]) =>
        ensureColumn(sqliteDb, 'positions', column, definition)
      );
    },
    '003_wallet_usage_flags.sqlite.sql': (sqliteDb) => {
      ensureColumn(
        sqliteDb,
        'sc_wallets',
        'usage_type',
        "TEXT NOT NULL DEFAULT 'other'"
      );
      ensureColumn(
        sqliteDb,
        'sc_wallets',
        'is_default_funding',
        'INTEGER NOT NULL DEFAULT 0'
      );
      ensureColumn(
        sqliteDb,
        'sc_wallets',
        'auto_attach_warchest',
        'INTEGER NOT NULL DEFAULT 0'
      );

      if (tableExists(sqliteDb, 'sc_wallets')) {
        const cols = sqliteDb.prepare('PRAGMA table_info(sc_wallets)').all();
        const names = new Set(cols.map((col) => col.name));
        if (!names.has('strategy') && !names.has('strategy_id')) {
          sqliteDb.exec('ALTER TABLE sc_wallets ADD COLUMN strategy_id TEXT NULL');
        }
      }

      sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_sc_wallets_usage_type ON sc_wallets (usage_type)');
      sqliteDb.exec(
        'CREATE INDEX IF NOT EXISTS idx_sc_wallets_default_funding ON sc_wallets (is_default_funding)'
      );
      sqliteDb.exec(
        'CREATE INDEX IF NOT EXISTS idx_sc_wallets_auto_attach ON sc_wallets (auto_attach_warchest)'
      );
    },
  };

  for (const file of files) {
    if (applied.has(file)) {
      logger.debug?.('[BootyBox:migrations] SQLite migration already applied, skipping', {
        migration: file,
      });
      continue;
    }

    if (shouldSkipMigration(file)) {
      logger.info?.('[BootyBox:migrations] SQLite migration already applied via schema bootstrap', {
        migration: file,
      });
      insertStmt.run(file, Date.now());
      continue;
    }

    const fullPath = pathModule.join(migrationsDir, file);
    const customMigration = customMigrations[file];
    const sql = customMigration ? null : fs.readFileSync(fullPath, 'utf8');

    logger.info?.('[BootyBox:migrations] Applying SQLite migration', {
      migration: file,
    });

    try {
      if (customMigration) {
        customMigration(sqlite);
        insertStmt.run(file, Date.now());
      } else {
        sqlite.exec('BEGIN');
        sqlite.exec(sql);
        insertStmt.run(file, Date.now());
        sqlite.exec('COMMIT');
      }
    } catch (err) {
      if (!customMigration) {
        try {
          sqlite.exec('ROLLBACK');
        } catch (rollbackErr) {
          logger.warn?.(
            `[BootyBox:migrations] SQLite rollback failed for migration ${file}: ${rollbackErr.message}`
          );
        }
      }
      logger.error?.(
        `[BootyBox:migrations] SQLite migration failed for ${file}: ${err.message}`
      );
      throw err;
    }
  }
}

async function runMigrations({ sqlite, logger = console } = {}) {
  logger.info?.('[BootyBox:migrations] runMigrations start');
  runSqliteMigrations(sqlite, logger);
  logger.info?.('[BootyBox:migrations] runMigrations complete');
}

module.exports = {
  runMigrations,
};
