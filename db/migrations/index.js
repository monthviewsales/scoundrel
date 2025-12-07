'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal migration runner for BootyBox.
 *
 * NOTE: MySQL migrations are deprecated and will only emit warnings. SQLite is
 * the only supported engine in current releases.
 *
 * This is intentionally dumb and side‑effect free:
 *  - The host app is responsible for constructing mysql/sqlite connections.
 *  - We just discover *.sql files in migrations/mysql and migrations/sqlite,
 *    run them in filename order, and record which ones have been applied.
 */

async function runMysqlMigrations(mysql, logger) {
  logger.warn?.(
    '[BootyBox:migrations] MySQL migrations are disabled. SQLite is the only supported engine.'
  );
  if (mysql?.end) {
    try {
      await mysql.end();
    } catch (err) {
      logger.debug?.(
        `[BootyBox:migrations] Ignoring MySQL teardown error after disablement: ${err.message}`
      );
    }
  }
}

function runSqliteMigrations(sqlite, logger) {
  if (!sqlite) {
    logger.warn?.('[BootyBox:migrations] SQLite db not provided, skipping SQLite migrations');
    return;
  }

  const migrationsDir = path.join(__dirname, 'sqlite');
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

  const getApplied = sqlite.prepare(
    'SELECT name FROM bootybox_migrations'
  );
  const appliedRows = getApplied.all();
  const applied = new Set(appliedRows.map((r) => r.name));

  // Handle legacy filenames so renamed migrations are not re-run.
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

  for (const file of files) {
    if (applied.has(file)) {
      logger.debug?.('[BootyBox:migrations] SQLite migration already applied, skipping', {
        migration: file,
      });
      continue;
    }

    const fullPath = path.join(migrationsDir, file);
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

/**
 * Migration entrypoint.
 *
 * The host app is responsible for:
 *  - constructing mysql/sqlite connections
 *  - deciding which driver(s) to migrate (mysql/sqlite/both)
 *
 * Example usage from a parent project:
 *
 *   const { runMigrations } = require('./submodules/BootyBox/migrations');
 *   await runMigrations({ driver: 'both', mysql: mysqlPool, sqlite: sqliteDb, logger });
 */
async function runMigrations({ driver = 'sqlite', mysql, sqlite, logger = console } = {}) {
  logger.info?.('[BootyBox:migrations] runMigrations start', { driver });

  if (driver === 'mysql' || driver === 'both') {
    await runMysqlMigrations(mysql, logger);
  }

  if (driver === 'sqlite' || driver === 'both') {
    runSqliteMigrations(sqlite, logger);
  }

  logger.info?.('[BootyBox:migrations] runMigrations complete');
}

module.exports = {
  runMigrations,
};
