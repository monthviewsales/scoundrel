# src – Agent Notes

- `index.js` forces SQLite and logs a deprecation warning for any other DB engine.
- `BootyBox.js` remains as a wrapper but only initializes the SQLite adapter (logger warns about MySQL).
- Adapters:
  - `adapters/sqlite.js` aggregates submodules (context, wallets, profiles, coins, trading, sessions).
  - `adapters/sqlite/context.js` owns the shared `better-sqlite3` handle and schema bootstrap; honors `BOOTYBOX_SQLITE_PATH`.
  - `adapters/mysql*.js` are stubs that warn/throw—do not revive without a plan.
- Utilities: `utils/logger.js` is the shared Winston logger used by warnings/wrappers.
