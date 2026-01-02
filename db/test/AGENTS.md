# test – Agent Notes

Inherits root `AGENTS.md`; local rules add/override.

- `sqlite.modules.test.js` exercises each SQLite submodule against an isolated temp database (see `helpers/sqliteTestUtils.js` for setup/cleanup).
- Use `BOOTYBOX_SQLITE_PATH` in tests when you need deterministic DB files; the helper already sets it per suite and clears module caches.
