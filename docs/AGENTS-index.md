# AGENTS.md Index

This repo uses per-directory `AGENTS.md` files. Always apply the closest one; local rules extend/override the root `AGENTS.md`.

Locations:
- `AGENTS.md` — root rules (base for all agents)
- `ai/AGENTS.md` — AI job/client rules
- `docs/AGENTS.md` — docs-only rules (tmp files, codex tasks)
- `db/AGENTS.md` — BootyBox + SQLite rules
- `db/src/AGENTS.md` — adapter layout + exports
- `db/src/adapters/AGENTS.md` — adapter module rules
- `db/src/adapters/sqlite/AGENTS.md` — sqlite module rules
- `db/migrations/AGENTS.md` — migration rules
- `db/test/AGENTS.md` — sqlite test rules
- `lib/wallets/AGENTS.md` — wallet domain rules
- `lib/warchest/workers/AGENTS.md` — worker entrypoint rules
- `lib/warchest/workers/monitors/AGENTS.md` — monitor helper rules
- `__tests__/warchest/workers/monitors/AGENTS.md` — monitor test rules
