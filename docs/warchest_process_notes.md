# Warchest worker options (hub vs. one-off subprocesses)

If Warchest remains the long-lived hub that owns BootyBox plus the SolanaTracker RPC/Data clients, spawn new work as **isolated child processes** instead of bolting everything into the hub. The goal is to keep the hub lean (connections, cache priming, wallet/DB bootstrap) while pushing heavy tasks into short-lived workers that you can reuse for tx/autopsy/coin monitors.

## Recommended Node.js patterns

- **Use `child_process.fork` for Scoundrel jobs.** Fork gives you IPC messaging for free so the hub can pass args (wallets, mint, RPC URL, Data API key) and receive progress/health messages without extra sockets.
- **Prepare a small worker harness** (e.g., `scripts/warchestWorker.js`) that:
  - imports BootyBox/SolanaTracker clients inside the worker (no cross-process client sharing),
  - accepts a job payload over `process.on('message', ...)`,
  - runs the requested job module (`tx`, `autopsy`, coin monitor),
  - tears down subscriptions with `await sub.unsubscribe()` and `await close()` before exit.
- **Have the hub launch and monitor workers:**
  - `const child = fork(workerPath, { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });`
  - Send a payload: `child.send({ type: 'start', job: 'coinMonitor', mint, wallets });`
  - Handle lifecycle: listen for `exit`, forward logs/health over IPC, and `child.unref()` when you truly want it backgrounded.

## How to keep resources clean

- Each worker initializes fresh RPC/Data clients; always call `await close()` on the RPC client and unsubscribe from every subscription before sending a `process.exit(0)` or letting the worker finish.
- Put shared helpers (wallet resolution, BootyBox open/close, status snapshot writing) into small modules the worker harness can import; avoid storing global state in the hub.
- If two monitors might target the same mint/wallet, add a minimal guard: write a PID/tag file per `(job, mint)` in `data/warchest/` and refuse to start if it already exists.

## When a registry is optional vs. useful

- **Optional:** If jobs are truly fire-and-forget and never overlap on the same mint/wallet, you can skip a central registry; the process boundary is the isolation.
- **Useful:** Add a light registry only when you need coordination—e.g., preventing duplicate coin monitors or exposing a “list active workers” CLI. This can live in the hub as an in-memory map keyed by job/mint with PID + start time, not a heavy manager.

This approach keeps Warchest as the stable hub while letting you bolt on new per-command workers that use the same primitives (BootyBox, SolanaTracker RPC/Data) without sharing live connections across processes.

## Blind spots and requirement gaps

- **Shared reporting contract.** The hub needs a small IPC schema so all workers report consistently (e.g., `{ type: 'log' | 'error' | 'progress' | 'result', job, id, payload }`). Without it, downstream consumers (HUD, CLIs, alerting) will drift.
- **Backpressure / max concurrency.** Forking is cheap but unbounded forks can exhaust file descriptors or saturate RPC/WebSocket limits. Add a simple queue or semaphore in the hub to cap simultaneous workers by job type.
- **Lifecycle hooks.** Standardize `setup()`/`teardown()` helpers (BootyBox open/close, RPC/Data client close) so every worker cleans up the same way. Otherwise long-lived sockets will linger when jobs crash.
- **Configuration surface.** Decide what the hub passes vs. what workers read from env. Prefer explicit payloads (RPC URLs, API keys, wallet aliases) to avoid surprises in multi-env deployments.
- **Audit/log retention.** Where should worker stdout/stderr go? Pipe back to the hub and write to rotating files (e.g., `data/warchest/logs/<job>.log`) or append to an existing logger so tx/autopsy/monitors share the same audit trail.

## Dependencies

- **No new runtime dependencies are required.** `child_process.fork`, IPC messaging, and fs-based PID/tag files are all native to Node.js.
- **Optional niceties:** If you want bounded queues or typed IPC, tiny deps like `p-limit` or `nanoid` can help but aren’t mandatory. Start with native primitives unless you hit a real need.

## Where to store worker modules and docs

- **Code placement:** Add a dedicated folder like `lib/warchest/workers/` for job entrypoints (`tradeWorker.js`, `txWorker.js`, `autopsyWorker.js`, `coinMonitorWorker.js`, `txMonitorWorker.js`). Keep the small harness (`warchestWorkerHarness.js`) nearby so every worker shares bootstrap/teardown helpers. The HUD worker now lives in this folder.
- **Shared client bootstrap:** Use `lib/warchest/client.js` to open BootyBox, create SolanaTracker RPC/Data clients, build initial wallet HUD state, and register cleanup handlers. Call `const client = await setup({ walletSpecs, mode });` and make sure to invoke `await client.close()` on shutdown so timers/subscriptions are cleared and the RPC client closes.
- **Health snapshot hook:** In daemon mode, reuse `client.writeStatusSnapshot(health)` when `updateHealth` reports fresh metrics so other CLIs can read `data/warchest/status.json`.
- **HUD integration:** Keep HUD-specific render/TUI code in `lib/warchest/workers/warchestHudWorker.js`, but have it consume worker results via IPC or a shared file instead of owning RPC subscriptions itself.
- **Docs:** Extend this file with per-worker “contract” snippets (payload shape, IPC messages, teardown rules) and add short READMEs in `lib/warchest/workers/` to keep code+docs co-located.

## Applicability to AI processes (dossier, autopsy)

- **Yes—same pattern works.** Dossier/autopsy already run as discrete jobs. Fork them as workers so they don’t block the hub and so each run owns its BootyBox/Data/RPC clients.
- **Data API-heavy tasks:** Ensure AI workers close HTTP clients and respect rate limits; the hub’s concurrency cap prevents bursty AI requests from starving trading workers.
- **Result delivery:** Have dossier/autopsy workers emit `{ type: 'ai:result', job, id, reportPath | summary }` so the HUD/CLI can display or persist outputs without holding the worker open.

## How the existing swap CLI fits into the worker model

The current trade command (`lib/cli/trade.js`) delegates to `lib/trades.js`, which caches a SolanaTracker client per wallet alias and calls `getSwapInstructions`/`performSwap` inside the main CLI process. The lower-level engine (`lib/swapEngine.js`) adds guards for BootyBox pending-swap flags and pulls token metadata via `ensureTokenInfo` before calling `performSwapWithDetails`.

To move swaps into the same forked-worker pattern as tx/autopsy/coin monitors:

- **Launch trades as forked jobs:** Instead of running swaps in the CLI process, have the CLI send a `trade` job to the worker harness with `{ side, mint, amount, walletAlias, slippagePercent, priorityFee, useJito, dryRun }`. The worker can reuse the same code paths (`buyToken`/`sellToken` or `performTrade`) without sharing live RPC clients.
- **Confine client caches to the worker lifetime:** `lib/trades.js` keeps a module-level `_clientCache`. In a worker, that cache dies with the process, so you avoid long-lived WebSocket connections and can skip manual teardown. If you keep trades in-process, add explicit shutdown hooks to close the SolanaTracker client and clear the cache to match the cleanup expectations of other workers.
- **Preserve BootyBox safety checks:** `performTrade` marks swaps as pending and clears the flag in `finally`. Keep that module untouched in the worker; the isolation prevents cross-job contamination while still avoiding concurrent swaps on the same mint.
- **Pass config/env explicitly over IPC when needed:** The worker should receive RPC URLs and API keys (or the wallet alias used to resolve them) from the hub so it doesn’t depend on ambient env vars. That mirrors how other workers will receive mint/wallet context for monitors.
- **Return summarized results to the CLI:** Send back the same shape the CLI prints today (txid, amounts, price impact, quote). The parent can handle log formatting while the worker stays focused on executing the swap and cleaning up RPC/Data clients before exit.

## How to hand off swap results to a transaction monitor and HUD

When a swap worker returns a `txid`, immediately spin up a transaction-monitor job as another forked worker so the hub/CLI stays responsive and doesn’t hold RPC/WebSocket subscriptions longer than necessary.

- **IPC result envelope:** Have the trade worker send `{ type: 'trade:complete', txid, walletAlias, mint, side, size, priceImpact }` over `process.send`. The parent (hub or CLI) can then launch the monitor worker with that payload.
- **Monitor worker duties:** The monitor only needs the txid plus wallet/mint context. Use the RPC client inside the monitor to subscribe to `logsSubscribe` or poll `getTransaction` until confirmation/err. Keep it short-lived: unsubscribe/close RPC before exit.
- **Error reporting:** If the monitor detects a confirmed error, send `{ type: 'trade:error', txid, reason }` back over IPC so the parent can log/alert. On success, send `{ type: 'trade:confirmed', txid, slot, signatureStatus }`.
- **HUD integration:** Treat the HUD as another IPC consumer. When the parent receives `trade:confirmed`, forward `{ txid, mint, side, walletAlias, filledSize }` to the HUD process (or write to the shared status file the HUD already reads). The HUD worker can then add the position by reusing the same BootyBox/open-position helpers it already uses for wallet tracking, without needing to observe the entire swap lifecycle.
- **No shared sockets:** Each phase (trade, monitor, HUD update) uses its own worker with fresh SolanaTracker RPC clients. The parent just relays messages, keeping the main hub lean and avoiding stuck WebSocket handles.
