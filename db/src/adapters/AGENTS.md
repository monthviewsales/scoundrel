# src/adapters – Agent Notes

- `sqlite/` holds the active adapter. `sqlite.js` aggregates submodules; `context.js` instantiates the DB and ensures the schema; other files split logic by table/domain (wallets, profiles, coins, trading, sessions).
- `sqlite/legacyAdapter.js` contains the previous monolithic SQLite implementation but now reuses `context` (no extra DB handle). Submodules wrap or override it as needed.
- `mysql.js` and `mysqlSchema.js` are disabled stubs kept for history; each call logs a yellow warning and throws.
- When adding new tables or helpers, extend the relevant submodule instead of `legacyAdapter` and update tests under `test/`.
