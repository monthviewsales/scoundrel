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
    if (file !== '011_sc_wallets_strategy.sqlite.sql') return false;
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
    const sql = fs.readFileSync(fullPath, 'utf8');

    logger.info?.('[BootyBox:migrations] Applying SQLite migration', {
      migration: file,
    });

    try {
      sqlite.exec('BEGIN');
      sqlite.exec(sql);
      insertStmt.run(file, Date.now());
      sqlite.exec('COMMIT');
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK');
      } catch (rollbackErr) {
        logger.warn?.(
          `[BootyBox:migrations] SQLite rollback failed for migration ${file}: ${rollbackErr.message}`
        );
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
