# AGENTS

This directory contains warchest worker entrypoints.

- Use **CommonJS** modules and add **JSDoc** for every exported helper.
- Keep workers small: delegate shared setup/teardown to `lib/warchest/client.js` and call its `close()` helper before exit.
- Always clean up timers and subscriptions you start in a worker.
