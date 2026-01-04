# src – Agent Notes

Inherits root `AGENTS.md`; local rules add/override.

- `index.js` directly exports the SQLite adapter (no engine switching).
- `adapters/sqlite.js` aggregates submodules (context, wallets, profiles, coins, trading, sessions).
- `adapters/sqlite/context.js` owns the shared `better-sqlite3` handle and schema bootstrap; honors `BOOTYBOX_SQLITE_PATH`.
- Utilities: `utils/logger.js` is the shared Winston logger used by wrappers/logging.
