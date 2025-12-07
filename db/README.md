# BootyBox (SQLite-only)

BootyBox is the shared persistence layer for the VAULT77 bots. The latest release **drops MySQL support** and runs exclusively on SQLite while keeping the MySQL artifacts around for reference (they now emit yellow-background warnings if touched).

## What’s inside
- SQLite adapter split into submodules (wallets, profiles, coins, trading, sessions) under `src/adapters/sqlite/`.
- Schema bootstrap + migrations for SQLite in `migrations/sqlite/`. MySQL migrations remain archived but are skipped with a warning.
- Env override `BOOTYBOX_SQLITE_PATH` to point tests or apps at a custom database file.
- Logger warnings (chalk yellow background) when any MySQL path is hit or when an unexpected `DB_ENGINE` value is supplied.

## Quick start
```bash
npm install
# optional: export BOOTYBOX_SQLITE_PATH=/tmp/bootybox-test.db
npm test   # runs SQLite submodule coverage; MySQL tests are skipped with a warning
```

Using the adapter:
```js
const BootyBox = require('./src'); // DB_ENGINE is ignored and forced to sqlite

(async () => {
  await BootyBox.init({
    sqlite: { filename: process.env.BOOTYBOX_SQLITE_PATH }, // optional
    logger: console,
  });

  const wallets = BootyBox.listWarchestWallets();
  console.log('wallet count', wallets.length);

  await BootyBox.close();
})();
```

## Migrations (SQLite only)
`migrations/index.js` still accepts `driver` for compatibility, but any MySQL run will log a yellow warning and return. To apply SQLite migrations from a host project:
```js
const { runMigrations } = require('./migrations');
const sqliteDb = require('better-sqlite3')(process.env.BOOTYBOX_SQLITE_PATH || './db/bootybox.db');

runMigrations({ driver: 'sqlite', sqlite: sqliteDb, logger: console });
```

## Tests
- `test/sqlite.modules.test.js` exercises each SQLite submodule (wallets, profiles, coins, trading, sessions) and keeps coverage above 70%.
- `test/parity.test.js` now `describe.skip`s with a yellow warning because MySQL support has ended.

## Repository layout
- `src/index.js` – entry that forces SQLite and logs a deprecation warning for other engines.
- `src/adapters/sqlite/` – context, submodules, and the refactored adapter surface.
- `src/adapters/mysql*.js` – kept for historical reference; every call throws with a yellow warning.
- `migrations/sqlite/` – active migrations; `migrations/mysql/` kept for history.
- `test/` – Jest suites for SQLite; MySQL parity suite is skipped with a warning.

## Contributing
- Work against SQLite only; do not resurrect MySQL without an explicit plan.
- Use `BOOTYBOX_SQLITE_PATH` for temporary/test databases to avoid clobbering shared files.
- Keep README human-focused and put agent-facing guidance in `AGENTS.md`.
