# BootyBox – Agent Notes

- SQLite is the only supported engine. Any MySQL import or migration emits a chalk yellow warning and throws.
- `DB_ENGINE` is ignored and coerced to SQLite; entrypoint logs a yellow warning at load.
- Use `BOOTYBOX_SQLITE_PATH` when you need an isolated database (tests, scratch runs). The path is read at module load time.
- SQLite adapter is split into submodules under `src/adapters/sqlite/` (context, wallets, profiles, coins, trading, sessions). Prefer using those exports when extending behavior.
- Migrations: only `migrations/sqlite/` should run. `runMigrations` with `driver='mysql'` will warn/skip.
- Jest tests live in `test/`; parity tests are skipped with a MySQL deprecation warning. Use `npm test` to validate.
