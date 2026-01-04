# Coin/Monitor Tests – Agent Notes

Inherits root `AGENTS.md`; local rules add/override.

- Keep Jest tests hermetic: mock RPC subscriptions, timers, and BootyBox/status writers.
- Assert cleanup (unsubscribe/close) behavior explicitly to prevent leaked handles.
- Prefer creating controllers via worker exports instead of forking child processes in unit tests.
