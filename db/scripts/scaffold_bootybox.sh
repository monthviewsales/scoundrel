#!/usr/bin/env bash
set -euo pipefail

# Scaffolds the SQLite-only BootyBox layout.
# - Creates the current directory structure
# - Writes SQLite-first entrypoints
# - Leaves MySQL stubs that warn/throw

ROOT_DIR="$(pwd)"
echo "Scaffolding BootyBox (SQLite-only) into $ROOT_DIR"

mkdir -p "$ROOT_DIR/src/adapters/sqlite"
mkdir -p "$ROOT_DIR/src/utils"
mkdir -p "$ROOT_DIR/migrations/sqlite"
mkdir -p "$ROOT_DIR/migrations/mysql"
mkdir -p "$ROOT_DIR/test"

write_if_missing() {
  local path="$1"
  local content="$2"
  if [ -f "$path" ]; then
    echo "Skipping: $path (already exists)"
  else
    printf "%s\n" "$content" > "$path"
    echo "Created: $path"
  fi
}

write_if_missing "$ROOT_DIR/index.js" "$(cat <<'EOF'
'use strict';
module.exports = require('./src');
EOF
)"

write_if_missing "$ROOT_DIR/src/index.js" "$(cat <<'EOF'
'use strict';

const chalk = require('chalk');
const logger = require('./utils/logger');

function loadBootyBox() {
  const requestedEngine = String(process.env.DB_ENGINE || 'sqlite').toLowerCase();
  const warning = chalk.bgYellow.black(
    `[BootyBox] DB_ENGINE=${requestedEngine} resolved to sqlite. MySQL support has ended; running with SQLite only.`
  );
  logger.warn(warning);
  return require('./adapters/sqlite');
}

module.exports = loadBootyBox();
EOF
)"

write_if_missing "$ROOT_DIR/src/BootyBox.js" "$(cat <<'EOF'
'use strict';

const chalk = require('chalk');
const createSqliteAdapter = require('./adapters/sqlite');
const logger = require('./utils/logger');

/**
 * Compatibility wrapper; initializes SQLite only.
 */
class BootyBox {
  constructor(options = {}) {
    this.options = options;
    this.driver = 'sqlite';
    this.logger = options.logger || logger;
    this.sqlite = null;
  }

  async init() {
    const warning = chalk.bgYellow.black(
      '[BootyBox] MySQL support has ended; initializing SQLite adapter only.'
    );
    this.logger.warn?.(warning);
    this.logger.info?.('[BootyBox] init start', { driver: 'sqlite' });
    this.sqlite = await createSqliteAdapter(this.options.sqlite || {}, this.logger);
    this.logger.info?.('[BootyBox] init complete');
  }

  async close() {
    this.logger.info?.('[BootyBox] close start');
    if (this.sqlite?.close) await this.sqlite.close();
    this.logger.info?.('[BootyBox] close complete');
  }
}

module.exports = BootyBox;
EOF
)"

write_if_missing "$ROOT_DIR/src/utils/logger.js" "$(cat <<'EOF'
'use strict';

const { createLogger, format, transports } = require('winston');

module.exports = createLogger({
  level: process.env.BOOTYBOX_LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${timestamp}] [BootyBox] ${level}: ${message}${metaStr}`;
    })
  ),
  transports: [new transports.Console()],
});
EOF
)"

write_if_missing "$ROOT_DIR/src/adapters/mysql.js" "$(cat <<'EOF'
'use strict';
const chalk = require('chalk');
const logger = require('../utils/logger');

const warn = (action) => {
  const msg = chalk.bgYellow.black(
    `[BootyBox] MySQL support has ended. Attempted to ${action}. SQLite is the only supported engine.`
  );
  logger.warn(msg);
  const err = new Error(msg);
  err.code = 'BOOTYBOX_MYSQL_DISABLED';
  throw err;
};

module.exports = {
  engine: 'mysql',
  init: () => warn('init mysql adapter'),
  ping: () => warn('ping mysql adapter'),
  close: () => warn('close mysql adapter'),
};
EOF
)"

write_if_missing "$ROOT_DIR/src/adapters/mysqlSchema.js" "$(cat <<'EOF'
'use strict';
const chalk = require('chalk');
const logger = require('../utils/logger');

async function ensureMysqlSchema() {
  const msg = chalk.bgYellow.black(
    '[BootyBox] MySQL schema management is disabled. SQLite is the only supported engine.'
  );
  logger.warn(msg);
  const err = new Error(msg);
  err.code = 'BOOTYBOX_MYSQL_SCHEMA_DISABLED';
  throw err;
}

module.exports = { ensureMysqlSchema };
EOF
)"

write_if_missing "$ROOT_DIR/src/adapters/sqlite.js" "$(cat <<'EOF'
'use strict';

// Stub aggregator for SQLite-only projects; replace with real implementation.
const BootyBox = {
  engine: 'sqlite',
  async init() {},
  async close() {},
};

module.exports = BootyBox;
module.exports.modules = {};
EOF
)"

write_if_missing "$ROOT_DIR/migrations/index.js" "$(cat <<'EOF'
'use strict';

async function runMysqlMigrations(mysql, logger = console) {
  logger.warn?.('[BootyBox:migrations] MySQL migrations are disabled; skipping.');
  if (mysql?.end) {
    try { await mysql.end(); } catch (err) { logger.debug?.(err.message); }
  }
}

function runSqliteMigrations(sqlite, logger = console) {
  if (!sqlite) {
    logger.warn?.('[BootyBox:migrations] SQLite db not provided, skipping SQLite migrations');
    return;
  }
  logger.info?.('[BootyBox:migrations] TODO: apply migrations/sqlite/*.sql');
}

async function runMigrations({ driver = 'sqlite', mysql, sqlite, logger = console } = {}) {
  logger.info?.('[BootyBox:migrations] runMigrations start', { driver });
  if (driver === 'mysql' || driver === 'both') await runMysqlMigrations(mysql, logger);
  if (driver === 'sqlite' || driver === 'both') runSqliteMigrations(sqlite, logger);
  logger.info?.('[BootyBox:migrations] runMigrations complete');
}

module.exports = { runMigrations };
EOF
)"

write_if_missing "$ROOT_DIR/test/basic-bootstrap.test.js" "$(cat <<'EOF'
'use strict';

const BootyBox = require('../src');

describe('BootyBox basic bootstrap', () => {
  it('exposes init/close on the selected adapter', () => {
    expect(typeof BootyBox.init).toBe('function');
    expect(typeof BootyBox.close).toBe('function');
  });
});
EOF
)"

echo "Scaffold complete. Adapt the SQLite adapter modules as needed."
