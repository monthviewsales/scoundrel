# AGENTS.md

This file is for **AI coding agents** (and other automation) working on this repository.
Humans should prefer `README.md` for project overview and usage.

Agents **must** read and follow this document before making any changes.

---

## Setup & Commands

Use these commands when planning, testing, or validating changes.

- Install dependencies:  
  - `npm install`
- Run unit tests (Jest):
  - `npm test`
- Run CI-grade tests with coverage (used by GitHub Actions):
  - `npm run test:ci`
- Run lints / static checks (if configured):
  - `npm run lint`
- Run the CLI in development mode:  
  - `NODE_ENV=development <CLI_ENTRYPOINT> ...`
- Run the CLI in production mode:  
  - `NODE_ENV=production <CLI_ENTRYPOINT> ...`

> **Agent note:** If you discover more accurate commands (e.g. via `package.json`), prefer those and update this file instead of guessing.

---

## Code Style & Structure

Follow these rules for **all new and modified code**:

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

- **Patterns**
  - Prefer small, single-responsibility modules.
  - Keep side effects at the edges (CLI entrypoints, process integration, network calls).
  - Larger services factories should be in /services and imported as needed.

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
