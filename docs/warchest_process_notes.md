# Warchest worker options (hub vs. one-off subprocesses)

If Warchest remains the long-lived hub that owns BootyBox plus the SolanaTracker RPC/Data clients, spawn new work as **isolated child processes** instead of bolting everything into the hub. The goal is to keep the hub lean (connections, cache priming, wallet/DB bootstrap) while pushing heavy tasks into short-lived workers that you can reuse for tx/autopsy/coin monitors.

## Recommended Node.js patterns

- **Use `child_process.fork` for Scoundrel jobs.** Fork gives you IPC messaging for free so the hub can pass args (wallets, mint, RPC URL, Data API key) and receive progress/health messages without extra sockets.
- **Prepare a small worker harness** (`lib/warchest/workers/harness.js`) that:
  - imports BootyBox/SolanaTracker clients inside the worker (no cross-process client sharing),
  - accepts a job payload over `process.on('message', ...)` via `createWorkerHarness`,
  - runs the requested job module (`tx`, `autopsy`, coin monitor),
  - tears down subscriptions with `await sub.unsubscribe()` and `await close()` before exit.
- **Have the hub launch and monitor workers:**
  - `const child = fork(workerPath, { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });`
  - Send a payload: `child.send({ type: 'start', job: 'coinMonitor', mint, wallets });`
  - Handle lifecycle: listen for `exit`, forward logs/health over IPC, and `child.unref()` when you truly want it backgrounded.

## How to keep resources clean

- Each worker initializes fresh RPC/Data clients; always call `await close()` on the RPC client and unsubscribe from every subscription before sending a `process.exit(0)` or letting the worker finish.
- Put shared helpers (wallet resolution, BootyBox open/close, status snapshot writing) into small modules the worker harness can import; avoid storing global state in the hub.
- If two monitors might target the same mint/wallet, add a minimal guard: use `createPidTag()` to write a lock in `data/warchest/locks/` and refuse to start if it already exists.
- The HUD worker now tracks every WebSocket handle created by the SolanaTracker Kit client and exposes the count in health snapshots (`service.sockets`). Client restarts terminate all tracked sockets; a normal count is 1–3. Watch for growth to catch cleanup regressions early.

## When a registry is optional vs. useful

- **Optional:** If jobs are truly fire-and-forget and never overlap on the same mint/wallet, you can skip a central registry; the process boundary is the isolation.
- **Useful:** Add a light registry only when you need coordination—e.g., preventing duplicate coin monitors or exposing a “list active workers” CLI. This can live in the hub as an in-memory map keyed by job/mint with PID + start time, not a heavy manager.

This approach keeps Warchest as the stable hub while letting you bolt on new per-command workers that use the same primitives (BootyBox, SolanaTracker RPC/Data) without sharing live connections across processes.

## Hub coordinator + event flow

- A lightweight coordinator now lives in `lib/warchest/hubCoordinator.js`. It routes commands to workers through the harness, enforces per-wallet/tx namespaces (duplicate `swap` or `txMonitor` calls on the same wallet/txid throw), and passes shared env hints down to the forked workers.
- HUD/monitor consumers subscribe to hub status and tx-event files via `lib/warchest/events.js`. When a hub is present, prefer the follower instead of opening another set of WebSocket subscriptions.
- Event files default to `data/warchest/status.json` (health snapshots) and `data/warchest/tx-events.json` (confirmed/failed tx summaries). Workers should respect overrides from env/CLI so tests can inject temporary paths.

### HUD transaction feed + env overrides

- The HUD worker now follows `tx-events.json` through `createHubEventFollower` and renders a live transaction list above logs. Only the newest N events are kept (`WARCHEST_HUD_MAX_TX`, default `10`).
- Status emojis mirror txMonitor: 🟢 confirmed, 🔴 failed, 🟡 everything else.
- Each item pulls mint metadata through `tokenInfoService.ensureTokenInfo` (with refresh) so names, price, and the 1m/5m/15m/30m price deltas appear once metadata exists. Missing metadata falls back to mint pubkeys.
- Per-wallet log lines remain but are capped independently (`WARCHEST_HUD_MAX_LOGS`, default `5`).
- Watch `data/warchest/status.json` for regressions: `ws.lastSlotAgeMs` should stay below `WARCHEST_WS_STALE_MS`, and `service.sockets` should hover around 1–3 after restarts. Rising `rssBytes` or `sockets` counts usually mean subscriptions leaked.

### Shutdown expectations

- Coordinators and HUD workers must close followers/watchers, timers, and RPC/Data clients on `SIGINT`/`SIGTERM`. The HUD worker now closes hub followers in addition to the RPC client.
- Monitors that write HUD events should do so via `appendHubEvent` (`lib/warchest/events.js`) and avoid leaving behind fs watchers when they exit.

## Blind spots and requirement gaps

- **Shared reporting contract.** The hub needs a small IPC schema so all workers report consistently (e.g., `{ type: 'log' | 'error' | 'progress' | 'result', job, id, payload }`). Without it, downstream consumers (HUD, CLIs, alerting) will drift.
- **Backpressure / max concurrency.** Forking is cheap but unbounded forks can exhaust file descriptors or saturate RPC/WebSocket limits. Add a simple queue or semaphore in the hub to cap simultaneous workers by job type.
- **Lifecycle hooks.** Standardize `setup()`/`teardown()` helpers (BootyBox open/close, RPC/Data client close) so every worker cleans up the same way. Otherwise long-lived sockets will linger when jobs crash.
- **Configuration surface.** Decide what the hub passes vs. what workers read from env. Prefer explicit payloads (RPC URLs, API keys, wallet aliases) to avoid surprises in multi-env deployments.
- **Audit/log retention.** Where should worker stdout/stderr go? Pipe back to the hub and write to rotating files (e.g., `data/warchest/logs/<job>.log`) or append to an existing logger so tx/autopsy/monitors share the same audit trail.

### IPC envelope + cleanup contract (implemented via `lib/warchest/workers/harness.js`)

- **Message envelope:** Parent sends `{ type: 'start', payload, requestId }` over IPC. Workers respond with `{ type: 'result' | 'error', payload, requestId }` and ignore mismatched IDs.
- **Timeouts:** Parents arm a timeout (default 30s) and `kill()` the worker if no response arrives. The promise rejects with `Worker timed out after <ms>ms`.
- **Lifecycle logging + metrics:** `createWorkerHarness` now emits structured lifecycle logs (`start`, `success`, `error`, `cleanup`) and accepts an optional metrics hook. Pass `workerName` to ensure messages stay grep-friendly (`[coinMonitor] start {...}`) and forward metrics into Winston if you need line-delimited counters.
- **Cleanup hooks:** Workers track resources via the harness. On exit, it calls `close()` then `unsubscribe()` on tracked resources, invokes an optional `onClose()` hook, removes `process` listeners, and exits. Parents also clear listeners and release PID tags/locks after any completion path.
- **Env and payload helpers:** `buildWorkerEnv` passes RPC/Data endpoints, wallet IDs, or BootyBox paths as env vars. Parents may still serialize the same values inside `payload` for clarity.
- **Lightweight coordination:** `createPidTag(tag, dir?)` writes `data/warchest/locks/<tag>.json` (or a custom dir) containing `{ pid, tag, ts }` and throws when a tag is already present, preventing duplicate workers.

## Dependencies

- **No new runtime dependencies are required.** `child_process.fork`, IPC messaging, and fs-based PID/tag files are all native to Node.js.
- **Optional niceties:** If you want bounded queues or typed IPC, tiny deps like `p-limit` or `nanoid` can help but aren’t mandatory. Start with native primitives unless you hit a real need.

## Where to store worker modules and docs

- **Code placement:** Keep job entrypoints in `lib/warchest/workers/` (`swapWorker.js`, `txMonitorWorker.js`, `autopsyWorker.js`, `dossierWorker.js`, `sellOpsWorker.js`). The harness lives in `lib/warchest/workers/harness.js`, and the HUD worker lives in this folder as `warchestService.js`.
- **Shared client bootstrap:** Use `lib/warchest/client.js` to open BootyBox, create SolanaTracker RPC/Data clients, build initial wallet HUD state, and register cleanup handlers. Call `const client = await setup({ walletSpecs, mode });` and make sure to invoke `await client.close()` on shutdown so timers/subscriptions are cleared and the RPC client closes.
- **Health snapshot hook:** In daemon mode, reuse `client.writeStatusSnapshot(health)` when `updateHealth` reports fresh metrics so other CLIs can read `data/warchest/status.json`.
- **HUD integration:** Keep HUD-specific render/TUI code in `lib/warchest/workers/warchestService.js`. It owns RPC subscriptions and also follows hub event/status files via `createHubEventFollower`.
- **Docs:** Extend this file with per-worker “contract” snippets (payload shape, IPC messages, teardown rules) and add short READMEs in `lib/warchest/workers/` to keep code+docs co-located.

## Applicability to AI processes (dossier, autopsy)

- **Yes—same pattern works.** Dossier/autopsy already run as discrete jobs. Fork them as workers so they don’t block the hub and so each run owns its BootyBox/Data/RPC clients.
- **Data API-heavy tasks:** Ensure AI workers close HTTP clients and respect rate limits; the hub’s concurrency cap prevents bursty AI requests from starving trading workers.
- **Result delivery:** Have dossier/autopsy workers emit `{ type: 'ai:result', job, id, reportPath | summary }` so the HUD/CLI can display or persist outputs without holding the worker open.

## How the existing swap CLI fits into the worker model

The swap command runs through the hub coordinator:

- `lib/cli/swap.js` calls `hub.runSwap(...)`, which routes to `swapWorker` via the harness.
- `swapWorker` delegates execution to the swap helpers under `lib/swap/` (currently `swapV3`), uses BootyBox for pending-swap guards and persistence, and emits a structured result back over IPC.
- If a swap produces a `txid`, the parent (CLI/hub) starts `txMonitorWorker` via the hub coordinator.

When adding new swap-related flows, keep the CLI thin and push execution into the worker so RPC clients and subscriptions stay short-lived.

### Swap worker contract (current)

- **Entrypoint:** `lib/warchest/workers/swapWorker.js` (forked via the harness).
- **Payload fields:**
  - `side`: `'buy'` or `'sell'` (required)
  - `mint`: SPL mint (Base58, 32–44 chars)
  - `amount`: number, percentage string (e.g., `'50%'`), or `'auto'` for sells
  - `walletAlias` (preferred), or `walletId`/`walletPubkey`/`walletPrivateKey` as fallbacks
  - `dryRun` boolean
  - `detachMonitor` boolean to run tx monitoring in a detached process
  - swap settings (slippage, priority fee, tx version, debug flags) are sourced from swap config.
- **Validation:** The worker rejects invalid sides, mint formats, negative/empty amounts, or missing wallet context before attempting a swap.
- **Execution:** A fresh swap client is created from the swap helpers under `lib/swap/`, using the provided keypair and mint/amount context. Each invocation owns its own SolanaTracker client and closes when the process exits.
- **Response envelope:** `{ txid, signature, slot, timing, tokensReceivedDecimal?, solReceivedDecimal?, totalFees?, priceImpact?, quote?, dryRun?, monitorPayload?, monitorDetach? }` where `timing` includes `startedAt`, `endedAt`, and `durationMs`.
- **CLI integration:** `lib/cli/swap.js` dispatches through the hub coordinator, forwards the payload, and surfaces results in CLI output. Errors from the worker propagate to the caller.

## How swap results flow to tx monitoring + HUD

- The parent (CLI/hub) starts `txMonitorWorker` for non-dry-run swaps using the `monitorPayload` returned by `swapWorker`. Detached monitoring uses a background spawn path.
- `txMonitorWorker` publishes events via `appendHubEvent` to `data/warchest/tx-events.json`; the HUD follows this file via `createHubEventFollower`.
- Detached monitoring writes a payload file and spawns a background process; the HUD still receives events once the monitor runs.

This keeps long-lived subscriptions in the monitor/HUD workers while the swap worker stays short-lived.

## Retry/backoff expectations (RPC + Data helpers)

- RPC/Data calls used by workers (token account hydration, tx confirmations) now wrap a shared retry helper with exponential backoff (default ~250–2000ms, 3–4 attempts) and treat ECONNRESET/ETIMEDOUT/EAI_AGAIN/5xx/429 as transient.
- Persistent failures bubble as errors so workers fail fast instead of silently continuing with empty state; supervisors should catch these and decide whether to restart.
- Metrics hooks receive `retry:*` and `error:*` events when provided so ops can alert on noisy links without parsing stdout.
