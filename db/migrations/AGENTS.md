# migrations – Agent Notes

Inherits root `AGENTS.md`; local rules add/override.

- Only SQLite migrations exist (`migrations/sqlite/*`).
- `runMigrations({ sqlite, logger })` expects a `better-sqlite3` connection and walks the directory applying pending files.
