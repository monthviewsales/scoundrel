# migrations – Agent Notes

- Only SQLite migrations are active (`migrations/sqlite/*`). MySQL migrations remain for history; `runMysqlMigrations` now logs a yellow warning and returns.
- `runMigrations({ driver: 'sqlite', sqlite, logger })` is the expected entry. Passing `mysql` or `driver: 'both'` will not execute MySQL changes.
- The runner is intentionally simple: it scans the folder, applies unapplied `.sql` files in order, and records them in `bootybox_migrations`.
