# migrations – Agent Notes

- Only SQLite migrations exist (`migrations/sqlite/*`).
- `runMigrations({ sqlite, logger })` expects a `better-sqlite3` connection and walks the directory applying pending files.
