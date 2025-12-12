# BootyBox – Agent Notes

- SQLite is the only engine; no fallbacks exist.
- `DB_ENGINE` is ignored unless it is set to something other than `sqlite`, in which case we log a warning and still load SQLite.
- Use `BOOTYBOX_SQLITE_PATH` when you need an isolated database (tests, scratch runs). The path is read at module load time.
- The adapter is split into submodules under `src/adapters/sqlite/` (context, wallets, profiles, coins, trading, sessions). Prefer using those exports when extending behavior.
- `migrations/sqlite/` holds the canonical schema upgrades; `migrations/index.js` only runs SQLite migrations.
- Jest tests live in `test/` and run alongside the rest of Scoundrel's suite (no separate submodule).
