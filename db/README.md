# BootyBox (SQLite)

BootyBox is the shared persistence layer for the VAULT77 bots. The SQLite file lives at `db/bootybox.db` by default (the old `db/db/bootybox.db` location is migrated automatically). It now lives natively inside Scoundrel under `db/` and runs exclusively on SQLite.

## What’s inside
- SQLite adapter split into submodules (wallets, profiles, coins, trading, sessions) under `src/adapters/sqlite/`.
- Schema bootstrap + migrations for SQLite in `migrations/sqlite/`.
- Env override `BOOTYBOX_SQLITE_PATH` to point tests or apps at a custom database file.
- Unified `sc_evaluations` table for buyOps/sellOps snapshots (keyed by `ops_type`).
- No MySQL support or fallbacks.

## Quick start
```bash
npm install
# optional: export BOOTYBOX_SQLITE_PATH=/tmp/bootybox-test.db
npm test   # runs the full Scoundrel suite, including BootyBox tests
```

Using the adapter:
```js
const BootyBox = require('./db');

(async () => {
  await BootyBox.init({
    sqlite: { filename: process.env.BOOTYBOX_SQLITE_PATH },
    logger: console,
  });

  const wallets = BootyBox.listWarchestWallets();
  console.log('wallet count', wallets.length);

  await BootyBox.close();
})();
```

## Migrations
`migrations/index.js` is SQLite-only. Provide an existing `better-sqlite3` instance: 
```js
const { runMigrations } = require('./db/migrations');
const sqliteDb = require('better-sqlite3')(process.env.BOOTYBOX_SQLITE_PATH || './db/bootybox.db');

runMigrations({ sqlite: sqliteDb, logger: console });
```

## Tests
- `test/sqlite.modules.test.js` exercises each SQLite submodule (wallets, profiles, coins, trading, sessions).

## Repository layout
- `src/index.js` – entry that exports the SQLite adapter.
- `src/adapters/sqlite/` – context, submodules, and the refactored adapter surface.
- `migrations/sqlite/` – active migrations.
- `test/` – Jest suites for the SQLite adapter surface.

## Contributing
- Work against SQLite only.
- Use `BOOTYBOX_SQLITE_PATH` for temporary/test databases to avoid clobbering shared files.
- Keep README human-focused and put agent-facing guidance in `AGENTS.md`.
