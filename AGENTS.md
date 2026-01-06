# AGENTS.md

This file is for **AI coding agents** (and other automation) working on this repository.
Humans should prefer `README.md` for project overview and usage.

Agents **must** read and follow this document before making any changes.

---

## AGENTS.md Precedence

- Treat this file as the **base** ruleset.
- If you work inside a directory that contains its own `AGENTS.md`, follow that file too; **nearest file wins** when rules conflict.
- Local rules extend or override these root rules; do not ignore them.

## Shared Patterns

- For creating new CLI analysis flows (dossier/autopsy/devscan pattern), follow `docs/analysis-flow-factory.md`.

### Known locations

- `ai/AGENTS.md`
- `docs/AGENTS.md`
- `db/AGENTS.md`
- `db/src/AGENTS.md`
- `db/src/adapters/AGENTS.md`
- `db/src/adapters/sqlite/AGENTS.md`
- `db/migrations/AGENTS.md`
- `db/test/AGENTS.md`
- `lib/wallets/AGENTS.md`
- `lib/warchest/workers/AGENTS.md`
- `lib/warchest/workers/monitors/AGENTS.md`
- `__tests__/warchest/workers/monitors/AGENTS.md`

---

## Setup & Commands

Use these commands when planning, testing, or validating changes.

- Install dependencies:  
  - `npm install`
- Run unit tests (Jest):
  - `npm test`
- Run CI-grade tests with coverage (used by GitHub Actions):
  - `npm run test:ci`
- Run lints / static checks:
  - `npm run lint` (syntax check via `scripts/lint.js`)
- Run the CLI in development mode:  
  - `NODE_ENV=development node index.js ...`
- Run the CLI in production mode:  
  - `NODE_ENV=production node index.js ...`

> **Agent note:** If you discover more accurate commands (e.g. via `package.json`), prefer those and update this file instead of guessing.

---

## Code Style & Structure

Follow these rules for **all new and modified code**:

- **Commit messages**
  - Prefer fuller commit messages (title + body). Use commit `6477c2456592d018f1b7f8cf8bc52e551a242fbe` as the template for style and depth.

- **Module system**
  - Use **CommonJS** everywhere.
  - Imports: `const foo = require('./foo');`
  - Exports: `module.exports = { ... }` or `module.exports = function () { ... };`
  - Do **not** introduce ESM (`import` / `export`) without explicit instructions.

- **Documentation**
  - Use **JSDoc** for:
    - Every exported function.
    - Public classes / constructors.
    - Non-trivial internal helpers where behavior isn’t obvious.
  - JSDoc should document:
    - Parameters (`@param`)
    - Return type (`@returns`)
    - Error behavior when relevant (`@throws`)
- **Environment variables**
  - When adding new environment variables, document them in `README.md` and add them to `.env.sample` with a brief comment.
  - Swap provider selection is controlled by `SWAP_API_PROVIDER` (`swapV3` default, `raptor` to use Raptor endpoints).
  - RPC retry tuning uses `KIT_RPC_MAX_RETRIES`, `KIT_RPC_RETRY_BASE_MS`, and `KIT_RPC_RETRY_MAX_MS`.

- **Patterns**
- Prefer small, single-responsibility modules.
- Keep side effects at the edges (CLI entrypoints, process integration, network calls).
- Larger services factories should be in /services and imported as needed.
- **Hub + worker orchestration**
  - Use `lib/warchest/hub.js` (`getHubCoordinator`) to dispatch `swap` and `txMonitor` jobs so namespace locking and shared env routing stay consistent.
  - Avoid calling `forkWorkerWithPayload` directly for swap/txMonitor outside the hub coordinator.
  - Worker entrypoints should use `createWorkerHarness` and `createWorkerLogger` for lifecycle logging and cleanup.
  - Detached workers should be spawned via `spawnWorkerDetached` (from the harness) so payload files and env handling stay consistent.
- **Solana error handling**
  - Use `lib/solana/errors` (`classifySolanaError`, `formatSolanaErrorMessage`) to normalize Solana/RPC errors.
  - Include `errorSummary` in HUD-facing payloads when available (tx monitor events and summaries).
  - Keep transport retry logic in `lib/solanaTrackerRPCClient.js` limited to read-only RPC calls.
- **Readline / TTY usage**
  - When modules need `process.stdin` / `process.stdout`, reference them at the moment you create a `readline` interface (e.g. inside the function) rather than capturing them at module load time. This keeps tests free of lingering `TTYWRAP` handles when they stub `process.stdin`/`stdout`.

### SolanaTracker clients

- docs/solanaTrackerData.md contains additional technical info about the SolanaTracker clients.
- **RPC** helpers live in `lib/solana/rpcMethods/`; **Data API** helpers live in `lib/solanaTrackerData/methods/`.
- Every Data API method belongs in its own file + Jest test (`__tests__/solanaTrackerData/methods/<name>.test.js`) and is bound via `lib/solanaTrackerDataClient.js`.
- All helpers must go through the shared retry/logger context (`createDataClientContext`) and expose meaningful errors (`DataApiError`).
- **Risk** (`getTokenRiskScores`) must continue returning `{ token, score, rating, factors, raw }` and keep factor/severity parsing in sync with docs.
- **Search** (`searchTokens`) must support arrays → comma lists and nested objects → JSON strings while rejecting empty filter sets.
- Datastream/WebSocket access is off limits; stick to HTTP endpoints only.

### SolanaTracker RPC (WebSockets)

Scoundrel uses SolanaTracker's RPC WebSocket endpoint for real‑time chain state and wallet updates. All AI agents must follow these rules when working with RPC or WebSocket code.

#### Connection Pattern (Required)
Always construct the RPC client the same way:

```js
const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
const rpcMethods = createRpcMethods(rpc, rpcSubs);
```

- `rpc` → HTTP JSON‑RPC methods
- `rpcSubs` → raw WebSocket subscription builders
- `rpcMethods` → Scoundrel’s wrapped RPC+WS API (preferred)
- `close()` → must be called when shutting down

#### Supported WebSocket Methods
The SolanaTracker RPC **mainnet** endpoint supports:

- `slotSubscribe` — **supported**, real‑time slot heartbeat
- `accountSubscribe` — **supported**, SOL/token account updates
- `logsSubscribe` — **supported**, program/wallet log streams

The following are **not** supported:

- `blockSubscribe` → returns JSON‑RPC `Method not found`

Agents must **not** attempt to enable or emulate blockSubscribe.

#### slotSubscribe: No Parameters Allowed
SolanaTracker’s `slotSubscribe` implementation requires **zero** parameters.

These are all invalid and will cause:

> `Invalid parameters: No parameters were expected`

Invalid examples:

```js
rpcSubs.slotSubscribe({});
rpcSubs.slotSubscribe({ commitment: 'processed' });
rpcSubs.slotSubscribe([]);
```

Correct usage:

```js
rpcMethods.subscribeSlot((ev) => {
  // ev = { slot: 382872076n, parent: 382872075n, root: 382872044n }
});
```

#### Slot Event Shape (Canonical)
A slot event always looks like:

```js
{
  slot: 382872076n,
  parent: 382872075n,
  root: 382872044n
}
```

Agents must not assume additional fields.

#### Proxy‑Aware WebSocket Client
Scoundrel overrides the default WebSocket with a proxy‑aware wrapper. Some runtimes provide WHATWG‑style WebSockets without an `.on` method.

**Rule:** Check before attaching `.on` handlers:

```js
if (typeof ws.on === 'function') {
  ws.on('unexpected-response', ...);
}
```

Do not assume `.on` exists.

#### Cleanup Requirements
Every subscription created by an agent must be cleaned up:

```js
const sub = await rpcMethods.subscribeSlot(...);
await sub.unsubscribe();
```

And the RPC client must be closed when the process shuts down:

```js
await close();
```

Failure to do so will leave open WS handles and prevent Scoundrel's daemon from exiting.

---

### Warchest Sessions

- Long-running warchest workers must keep `sc_sessions` accurate: close stale records using `data/warchest/status.json`, start a new session only after the RPC client is healthy, heartbeat via `BootyBox.updateSessionStats`, and end the session on every shutdown path.
- `data/warchest/status.json` should now include `health.session` (session id, slots, block times) so CLI commands and crash recovery logic can read it without poking the database directly.
