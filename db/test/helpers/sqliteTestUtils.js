'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function clearSqliteModulesFromCache() {
  const targets = [
    '../../src/adapters/sqlite',
    '../../src/adapters/sqlite.js',
    '../../src/adapters/sqlite/context.js',
    '../../src/adapters/sqlite/legacyAdapter.js',
    '../../src/adapters/sqlite/wallets.js',
    '../../src/adapters/sqlite/profiles.js',
    '../../src/adapters/sqlite/coins.js',
    '../../src/adapters/sqlite/trading.js',
    '../../src/adapters/sqlite/sessions.js',
  ];

  for (const target of targets) {
    try {
      const resolved = require.resolve(path.join(__dirname, target));
      delete require.cache[resolved];
    } catch (err) {
      // ignore missing modules
    }
  }
}

function cleanDatabase(context) {
  const { db, pendingSwaps, tradeUuidMap } = context;
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all();
  for (const { name } of rows) {
    db.prepare(`DELETE FROM ${name}`).run();
  }
  pendingSwaps?.clear?.();
  tradeUuidMap?.clear?.();
}

function createIsolatedAdapter() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootybox-sqlite-'));
  process.env.BOOTYBOX_SQLITE_PATH = path.join(tmpDir, 'bootybox.db');
  clearSqliteModulesFromCache();

  const adapter = require('../../src/adapters/sqlite');
  const context = require('../../src/adapters/sqlite/context');

  cleanDatabase(context);

  return { adapter, context, tmpDir };
}

module.exports = {
  cleanDatabase,
  createIsolatedAdapter,
};
