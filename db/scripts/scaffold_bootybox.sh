#!/usr/bin/env bash
set -euo pipefail

# Scaffolds a minimal SQLite-only BootyBox layout directly under the current
# working directory. Creates directories, entrypoints, and a stub SQLite
# adapter so contributors can start hacking quickly.

ROOT_DIR="$(pwd)"
echo "Scaffolding BootyBox (SQLite-only) into $ROOT_DIR"

mkdir -p "$ROOT_DIR/src/adapters/sqlite"
mkdir -p "$ROOT_DIR/src/utils"
mkdir -p "$ROOT_DIR/migrations/sqlite"
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

write_if_missing "$ROOT_DIR/index.js" "$(cat <<'JS'
'use strict';
module.exports = require('./src');
JS
)"

write_if_missing "$ROOT_DIR/src/index.js" "$(cat <<'JS'
'use strict';

const chalk = require('chalk');
const logger = require('./utils/logger');

function loadBootyBox() {
  const requestedEngine = String(process.env.DB_ENGINE || 'sqlite').toLowerCase();
  if (requestedEngine !== 'sqlite') {
    const warning = chalk.bgYellow.black(
      `[BootyBox] DB_ENGINE=${requestedEngine} resolved to sqlite. SQLite is the only supported engine.`
    );
    logger.warn(warning);
  }
  return require('./adapters/sqlite');
}

module.exports = loadBootyBox();
JS
)"

write_if_missing "$ROOT_DIR/src/BootyBox.js" "$(cat <<'JS'
'use strict';

const createSqliteAdapter = require('./adapters/sqlite');
const logger = require('./utils/logger');

class BootyBox {
  constructor(options = {}) {
    this.options = options;
    this.driver = 'sqlite';
    this.logger = options.logger || logger;
    this.sqlite = null;
  }

  async init() {
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
JS
)"

write_if_missing "$ROOT_DIR/src/utils/logger.js" "$(cat <<'JS'
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
JS
)"

write_if_missing "$ROOT_DIR/src/adapters/sqlite.js" "$(cat <<'JS'
'use strict';

// Stub aggregator for SQLite-only projects; replace with the real implementation
// when wiring up BootyBox internals.
const BootyBox = {
  engine: 'sqlite',
  async init() {},
  async close() {},
};

module.exports = BootyBox;
module.exports.modules = {};
JS
)"

write_if_missing "$ROOT_DIR/migrations/index.js" "$(cat <<'JS'
'use strict';

function runSqliteMigrations(sqlite, logger = console) {
  if (!sqlite) {
    logger.warn?.('[BootyBox:migrations] SQLite db not provided, skipping migrations');
    return;
  }
  logger.info?.('[BootyBox:migrations] TODO: apply migrations/sqlite/*.sql');
}

async function runMigrations({ sqlite, logger = console } = {}) {
  logger.info?.('[BootyBox:migrations] runMigrations start');
  runSqliteMigrations(sqlite, logger);
  logger.info?.('[BootyBox:migrations] runMigrations complete');
}

module.exports = { runMigrations };
JS
)"

write_if_missing "$ROOT_DIR/test/basic-bootstrap.test.js" "$(cat <<'JS'
'use strict';

const BootyBox = require('../src');

describe('BootyBox basic bootstrap', () => {
  it('exposes init/close on the adapter', () => {
    expect(typeof BootyBox.init).toBe('function');
    expect(typeof BootyBox.close).toBe('function');
  });
});
JS
)"

echo "Scaffold complete."
