# src – Agent Notes

- `index.js` forces SQLite and logs a warning only when `DB_ENGINE` isn't `sqlite`.
- `BootyBox.js` remains as a wrapper but only initializes the SQLite adapter.
- Adapters:
  - `adapters/sqlite.js` aggregates submodules (context, wallets, profiles, coins, trading, sessions).
  - `adapters/sqlite/context.js` owns the shared `better-sqlite3` handle and schema bootstrap; honors `BOOTYBOX_SQLITE_PATH`.
- Utilities: `utils/logger.js` is the shared Winston logger used by warnings/wrappers.
