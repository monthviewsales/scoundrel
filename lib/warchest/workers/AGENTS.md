# AGENTS

This directory contains warchest worker entrypoints.

- Use **CommonJS** modules and add **JSDoc** for every exported helper.
- Keep workers small: delegate shared setup/teardown to `lib/warchest/client.js` and call its `close()` helper before exit.
- Always clean up timers and subscriptions you start in a worker.
- When adding monitors or other long-running workers, persist lightweight status snapshots via the hooks in `lib/warchest/client.js` instead of opening new BootyBox instances.
- The HUD/daemon worker manages `sc_sessions`: close any stale session found in `data/warchest/status.json`, start a new session only after RPC is ready, update it via the health loop, and end it on every shutdown code path (`SIGINT`, `SIGTERM`, CLI stop, crash handlers).
- Hub-facing workers (HUD, monitors, hub coordinator) should listen to `lib/warchest/events.js` followers instead of duplicating subscriptions when a hub is present, and must close any followers/watchers during shutdown.
