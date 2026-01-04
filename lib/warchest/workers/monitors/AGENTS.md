# Monitors – Agent Notes

Inherits root `AGENTS.md`; local rules add/override.

This directory holds helpers shared by warchest monitor workers (coin, tx, etc.).

- Use CommonJS modules with JSDoc for every exported function.
- Keep helpers free of side effects; let the worker own lifecycle and logging.
- Persist monitor state via BootyBox/status snapshot hooks exposed by the worker rather than opening new clients here.
- Expose cleanup-friendly APIs (return unsubscribe/close handles) so worker harness cleanup stays reliable.
