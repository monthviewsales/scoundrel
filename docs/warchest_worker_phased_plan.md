# Warchest Worker System — Phased Execution Plan

This plan builds on the prior warchest process notes and defines a staged path to deliver a reusable worker-based architecture (hub + child processes) for swaps, monitoring, and AI workflows. Each phase ends with an operational increment and includes documentation and testing expectations so coding agents can implement with precision.

## Phase 1 — Baseline extraction and structure
- **Goal:** Separate reusable worker harness from HUD/daemon and establish repository structure with clear agent guidance.
- **Tasks:**
  - Extract current HUD worker internals (BootyBox initialization, SolanaTracker RPC/Data clients, wallet state, health snapshotting) into a reusable module (e.g., `lib/warchest/client.js`).
  - Introduce a `lib/warchest/workers/` domain for worker entrypoints (HUD, swap, tx monitor, coin monitor, dossier/autopsy). Add `AGENTS.md` in the new directory describing scope, CommonJS/JSDoc rules, and cleanup expectations.
  - Keep the HUD renderer as a thin wrapper around the shared client state; ensure startup/shutdown flows call the shared `close()` logic.
- **Documentation:**
  - Update or add module-level JSDoc for exported factories/functions in the new client and worker harness.
  - Document the new directory layout and usage in `docs/warchest_process_notes.md`.
- **Testing:**
  - Add/adjust unit tests for the extracted client to validate BootyBox wiring and RPC/Data client creation stubs.
  - Smoke-test HUD CLI path to confirm it still launches with the new client.
- **Exit criteria:** A reusable client module exists; HUD uses it; workers directory with AGENTS guidance is present.

## Phase 2 — Worker harness and IPC contracts
- **Goal:** Standardize how child processes are spawned, configured, and cleaned up.
- **Tasks:**
  - Implement a worker harness module (e.g., `lib/warchest/workers/harness.js`) that forks child processes with an IPC envelope `{ type, payload, requestId }`, handles timeouts, and performs cleanup (`close()` on SolanaTracker clients, unsubscribes, process exit listeners).
  - Provide helper utilities for passing configuration (RPC/Data endpoints, wallet ids, BootyBox paths) via environment or serialized payloads.
  - Add lightweight coordination helpers if needed (per-wallet locks or PID-tag files) without introducing a heavy registry.
- **Documentation:**
  - Add JSDoc to harness functions describing payload shapes and lifecycle hooks.
  - Extend `docs/warchest_process_notes.md` with the IPC envelope contract and cleanup rules.
- **Testing:**
  - Unit tests for harness IPC send/receive, timeout handling, and cleanup callbacks (mocked child processes).
  - Integration test for a sample worker using the harness that starts, exchanges a message, and exits cleanly.
- **Exit criteria:** A reusable harness exists with documented IPC contracts and passing tests.

## Phase 3 — Swap worker refactor
- **Goal:** Run swaps (trade.js + swapEngine.js) inside forked workers and report transaction IDs.
- **Tasks:**
  - Create a swap worker entry (e.g., `lib/warchest/workers/swapWorker.js`) that loads `trade.js`/`swapEngine.js`, executes a swap based on payload, and returns `{ txid, signature, slot, timing }`.
  - Ensure BootyBox safeguards and config resolution remain intact; avoid shared state by instantiating fresh clients per worker.
  - Add JSDoc for worker request/response payloads.
  - CLI path (`lib/cli/trade.js`) should fork the swap worker through the harness and propagate success/failure.
- **Documentation:**
  - Update CLI docs to describe the worker-based swap flow.
  - Note required payload fields and retry/error semantics in `docs/warchest_process_notes.md`.
- **Testing:**
  - Unit tests for the swap worker with mocked RPC/Data clients verifying payload validation and response forwarding.
  - CLI-level test (mocked) ensuring trade command spawns worker and surfaces txid or error codes.
- **Exit criteria:** Swaps execute via worker; CLI returns txid; tests cover payload and IPC paths.

## Phase 4 — Transaction monitor chaining
- **Goal:** Automatically spawn a transaction monitor after a successful swap and stream outcomes back to the hub/HUD.
- **Tasks:**
  - Implement `lib/warchest/workers/txMonitorWorker.js` that subscribes to logs or confirmations for a given txid and reports `{ status, err?, slot }`.
  - Teach the swap worker (or trade CLI) to fork the monitor worker upon receiving a txid, passing initial context (mint, wallet, side, size) for downstream HUD updates.
  - Add hooks for emitting HUD-friendly events (e.g., via a message bus or shared status file) without requiring the HUD to observe the full swap lifecycle.
- **Documentation:**
  - JSDoc for monitor payload/response and cleanup expectations.
  - Update HUD documentation to describe how it consumes monitor results to add/update positions.
- **Testing:**
  - Unit tests mocking RPC subscriptions to ensure monitor reports success/failure and cleans up subscriptions.
  - Integration-style test chaining swap → monitor (both mocked) to verify IPC handoff works.
- **Exit criteria:** Swap flow launches a monitor automatically; monitor results reach HUD channels; tests validate chaining.

## Phase 5 — Coin monitor worker
- **Goal:** Support per-mint monitoring with isolated RPC/WebSocket connections and optional Data API usage.
- **Tasks:**
  - Add `lib/warchest/workers/coinMonitorWorker.js` that accepts a mint and wallet context, opens account/log subscriptions, and tracks balance deltas until exit conditions (user command or balance zero).
  - Provide start/stop controls through the harness and optional persistence hooks (BootyBox, status snapshots) per worker.
  - Add AGENT guidance if new directories are introduced (e.g., `lib/warchest/workers/monitors/AGENTS.md`).
- **Documentation:**
  - JSDoc for monitor start/stop APIs and exit condition handling.
  - Expand docs with operational notes (e.g., multiple monitors allowed, lockfile guidance if needed).
- **Testing:**
  - Unit tests with mocked RPC subscriptions verifying start/stop, exit conditions, and cleanup.
- **Exit criteria:** Coin monitors run as workers with controlled lifecycle and documentation/tests in place.

## Phase 6 — AI workers (dossier, autopsy)
- **Goal:** Align AI workflows with the worker model for isolation and predictable resource usage.
- **Tasks:**
  - Add worker entries (e.g., `lib/warchest/workers/dossierWorker.js`, `autopsyWorker.js`) that orchestrate existing AI logic, reading configs via harness payloads.
  - Ensure they emit structured results consumable by CLI or HUD and close any network/file handles on exit.
- **Documentation:**
  - JSDoc for AI worker payloads and outputs.
  - Update AI-related docs to reference worker entrypoints and invocation patterns.
- **Testing:**
  - Unit tests with mocked AI service calls validating payload validation and result forwarding.
- **Exit criteria:** AI commands run via workers with documented payloads and tests.

## Phase 7 — HUD/HUB integration and coordination
- **Goal:** Finalize hub orchestration and HUD consumption of worker outputs while preventing conflicting processes.
- **Tasks:**
  - Implement a lightweight hub coordinator that routes command requests to workers via the harness, manages per-wallet or per-tx namespaces, and prevents conflicting simultaneous actions where required.
  - HUD should subscribe to hub events (IPC, file-based status, or message bus) to update positions and health without duplicating subscriptions.
  - Consolidate cleanup hooks (process signals, shutdown) to close all active workers and SolanaTracker clients.
- **Documentation:**
  - Update `docs/warchest_process_notes.md` with the finalized orchestration flow, event channels, and shutdown behavior.
  - Ensure AGENTS.md files in new directories reflect final rules and expectations for future agents.
- **Testing:**
  - End-to-end test harness (mocked RPC/Data) covering swap → monitor → HUD update and coin monitor lifecycle.
  - Regression tests for HUD startup/teardown using the shared client.
- **Exit criteria:** Hub + HUD run with coordinated worker orchestration; end-to-end tests pass; documentation/AGENTS are current.

## Phase 8 — Hardening and observability
- **Goal:** Stabilize the system for production-like use with metrics, logging, and failure recovery.
- **Tasks:**
  - Add standardized logging around worker lifecycle events, payloads, and errors; ensure logs are structured for filtering.
  - Introduce optional metrics hooks (counters/timers) if supported by existing logging infra (no new runtime deps unless approved).
  - Add retries/backoff for transient RPC/Data failures and document the behavior.
- **Documentation:**
  - JSDoc on logging/metrics helpers and configuration flags.
  - Finalize operations runbook in docs covering troubleshooting, log locations, and recovery steps.
- **Testing:**
  - Unit tests for retry/backoff utilities and logging hooks.
  - Fault-injection tests (mocked) ensuring workers recover or fail fast with clear errors.
- **Exit criteria:** Observability and resilience features are in place; tests validate failure handling; docs/runbook are updated.

## Phase 9 — Cleanup and release readiness
- **Goal:** Ensure repository hygiene, documentation completeness, and repeatable testing.
- **Tasks:**
  - Remove obsolete daemon/HUD coupling code and legacy PID handling superseded by the harness/hub.
  - Confirm all new directories include AGENTS.md with up-to-date guidance.
  - Verify JSDoc coverage for all exported functions/classes and regenerate any API docs if applicable.
  - Ensure npm scripts include relevant test targets for workers/hub and that CI config (if present) runs them.
- **Documentation:**
  - Summarize the final architecture in `README.md` and ensure cross-links to detailed docs.
- **Testing:**
  - Run full Jest suite and any linters; verify no open handles in tests.
- **Exit criteria:** Codebase reflects the new worker architecture end-to-end; docs and AGENTS are complete; tests/CI pass.
