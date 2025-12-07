# scripts – Agent Notes

- `migrate_mysql_to_sqlite.js` migrates data from a live MySQL database into a BootyBox SQLite file. Set `MYSQL_*` env vars, optional `BOOTYBOX_SQLITE_PATH`, and optional `EXPORT_CSV_DIR` to also dump per-table CSV snapshots.
- `scaffold_bootybox.sh` is a helper to lay down the SQLite-only project skeleton (entrypoints, stubs, logger, and migration runner). It leaves existing files untouched.
