# src/adapters/sqlite – Agent Notes

- `context.js` is the single `better-sqlite3` handle. It bootstraps schemas via `ensureSqliteSchema`, caches `tradeUuidMap`/`pendingSwaps`, and reads `BOOTYBOX_SQLITE_PATH` at require time. Clear caches in tests via `test/helpers/sqliteTestUtils.js`.
- `wallets.js` and `profiles.js` are fully extracted implementations. They override the legacy adapter exports in `sqlite.js`.
- `coins.js`, `trading.js`, and `sessions.js` currently wrap the legacy logic for those tables; migrate logic here when you touch those areas.
- `legacyAdapter.js` is the former monolith refit to use `context`. Keep it in sync until all logic is migrated.
- `sqlite.js` aggregates all submodules and re-exports a BootyBox-compatible surface (`modules` export exposes each submodule for direct use).
