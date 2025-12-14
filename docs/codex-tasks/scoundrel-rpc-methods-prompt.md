
You are working in my local repo **`scoundrel`**.  
This project is a Solana Blockchain data backbone built in Node.js CLI (CommonJS) that talks to **SolanaTracker.io** RPC and Data APIs. It uses `@solana/kit` under the hood via a wrapper called `createSolanaTrackerRPCClient`.

Your task:  
**Design and implement a modular “RPC methods library” on top of my existing SolanaTracker RPC client, and then wire the new HUD worker to use it for SOL balances.**

You have access to:

- The repo files (via VS Code).
- The Solana MCP server (for Solana-specific help/tools if needed).
- SolanaTracker RPC docs for the methods I care about right now.

---

## 0. Project context & constraints

**Important project rules:**

- Code style:
  - **CommonJS** (`require`, `module.exports`), not ESM.
  - Node 22.x, `better-sqlite3`, `chalk`, `dotenv`, etc.
  - Use **JSDoc** for public-facing functions.
  - Keep code **lint-friendly** (I use ESLint).
- This repo **already has**:
  - `lib/solanaTrackerRPCClient.js` — wraps SolanaTracker RPC (HTTP + WebSocket) using `@solana/kit` (Anza).
  - `db` — SQLite-backed BootyBox helpers (see `db/src/adapters/sqlite`).
  - `lib/cli/warchestCli.js` — CLI command for the “warchest” wallet registry.
  - `scripts/warchestService.js` — long-running wallet HUD (we just built this; it currently calls `createSolanaTrackerRPCClient()` and tries to use `rpc.getBalance()` directly).
- Do **not** rip out or reinvent my connection logic.  
  Build **on top** of `createSolanaTrackerRPCClient()`.

- Testing & docs:
  - **Every new RPC method** must have **unit test coverage** (Jest) with mocked RPC clients.
  - Documentation must be updated to describe:
    - The new RPC methods library and its API.
    - How other modules (like HUD, dossier, etc.) are expected to consume it.
  - Keep the existing VAULT77 / Scoundrel vibe in doc wording.

---

## 1. Read the relevant code first

Before you change anything, open and read:

1. `lib/solanaTrackerRPCClient.js`
   - Understand:
     - How `rpc` (HTTP) is created.
     - How `rpcSubs` (WebSocket subscriptions) is created.
     - What `createSolanaTrackerRPCClient()` returns.
     - How logging and AbortControllers are handled.
2. `scripts/warchestService.js`
   - Understand:
     - How it calls `createSolanaTrackerRPCClient()`.
     - How it currently uses `rpc` in `fetchSolBalance` / `refreshAllSolBalances`.
     - The `WalletState` structure, especially `startSolBalance`, `solBalance`, `solDelta`.
3. (Optional but useful) `lib/cli/warchestCli.js` and `index.js`
   - To get a sense of CLI patterns and how this HUD worker will eventually be launched.

Do **not** start coding until you understand how those pieces fit.

---

## 2. Read the SolanaTracker RPC docs (don’t assume)

Next, you must read these SolanaTracker docs to understand the actual method shapes and parameters. **Do not assume** they behave identically to standard Solana RPC:

### WebSocket methods:

- `accountSubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/accountsubscribe
- `accountUnsubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/accountunsubscribe
- `blockSubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/blocksubscribe
- `blockUnsubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/blockunsubscribe
- `slotSubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/slotsubscribe
- `slotUnsubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/slotunsubscribe
- `slotsUpdatesSubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/slotsupdatessubscribe
- `slotsUpdatesUnsubscribe`:  
  https://docs.solanatracker.io/solana-rpc/websockets/slotsupdatesunsubscribe

### HTTP (non-WebSocket) methods:

Some of these are **custom** to SolanaTracker — read their docs carefully:

- `getTokenAccountsByOwnerV2`:  
  https://docs.solanatracker.io/solana-rpc/http/gettokenaccountsbyownerv2
- `getMultipleAccounts`:  
  https://docs.solanatracker.io/solana-rpc/http/getmultipleaccounts
- `getTokenAccountsByOwner`:  
  https://docs.solanatracker.io/solana-rpc/http/gettokenaccountsbyowner
- `getFirstAvailableBlock`:  
  https://docs.solanatracker.io/solana-rpc/http/getfirstavailableblock
- `getTransaction`:  
  https://docs.solanatracker.io/solana-rpc/http/gettransaction

Use this understanding to design method signatures that make sense for Scoundrel.

---

## 3. Architecture: RPC methods library

### 3.1. High-level structure

Create a new folder:

- `lib/solana/rpcMethods/`

Inside it:

1. `index.js` — factory that binds `rpc` + `rpcSubs` and returns an object of high-level methods.
2. One file **per method or method family**, for example:
   - `getSolBalance.js`
   - `getTokenAccountsByOwner.js` (v1)
   - `getTokenAccountsByOwnerV2.js`
   - `getMultipleAccounts.js`
   - `getFirstAvailableBlock.js`
   - `getTransaction.js`
   - `subscribeAccount.js`
   - `subscribeBlock.js`
   - `subscribeSlot.js`
   - `subscribeSlotsUpdates.js`

Each per-method file should:

- Export a **factory function** that takes `rpc` or `rpcSubs` and returns a high-level JS function.
- Use **JSDoc** to clearly document parameters and return types, including any SolanaTracker-specific behavior (like `changedSince`, `excludeZero`, cursor pagination, etc.).
- Encapsulate all the `.send()` / JSON-RPC plumbing so **callers never touch it.**

### 3.2. `createRpcMethods` factory

In `lib/solana/rpcMethods/index.js`, create:

```js
/**
 * Bind all RPC helper methods to the provided clients.
 *
 * @param {*} rpc      - HTTP RPC client from createSolanaTrackerRPCClient()
 * @param {*} rpcSubs  - WebSocket subscriptions client from createSolanaTrackerRPCClient()
 * @returns {Object}   - All bound RPC methods used across Scoundrel.
 */
function createRpcMethods(rpc, rpcSubs) {
  return {
    // simple example:
    getSolBalance: createGetSolBalance(rpc),

    // token accounts:
    getTokenAccountsByOwner: createGetTokenAccountsByOwner(rpc),
    getTokenAccountsByOwnerV2: createGetTokenAccountsByOwnerV2(rpc),

    // accounts:
    getMultipleAccounts: createGetMultipleAccounts(rpc),

    // blocks / transactions:
    getFirstAvailableBlock: createGetFirstAvailableBlock(rpc),
    getTransaction: createGetTransaction(rpc),

    // subscriptions:
    subscribeAccount: createSubscribeAccount(rpcSubs),
    subscribeBlock: createSubscribeBlock(rpcSubs),
    subscribeSlot: createSubscribeSlot(rpcSubs),
    subscribeSlotsUpdates: createSubscribeSlotsUpdates(rpcSubs),
  };
}

module.exports = { createRpcMethods };
```

The `createX` factories referenced here should each live in their own file, imported at top.

---

## 4. Design the individual method APIs

### 4.1. Minimal methods required for HUD v1

Right now, HUD only truly *needs* one method, plus we’re planning for more:

1. `getSolBalance(pubkey: string): Promise<number>`
   - Returns **SOL** as a JS number (not lamports).
   - Internally:
     - Calls the appropriate SolanaTracker RPC method (likely `getBalance` via `rpc`).
     - Deals with `.send()` / `.value` / lamport conversion.
   - Do **not** assume the underlying shape — derive it from `createSolanaTrackerRPCClient` and docs.

2. `getTokenAccountsByOwner(pubkey: string, opts?: {...})`
3. `getTokenAccountsByOwnerV2(pubkey: string, opts?: {...})`
   - Use the docs to define options:
     - `mint`, `programId`, `encoding`, `limit`, `changedSince`, `excludeZero`, pagination cursor, etc.
   - Return a normalized shape suitable for HUD and future analytics:
     - For V2, include `accounts`, `hasMore`, `nextCursor`, `totalCount`.

4. `getMultipleAccounts(pubkeys: string[], opts?)`
5. `getFirstAvailableBlock()`
6. `getTransaction(signature: string, opts?)`

### 4.2. WebSocket subscription helpers

For now, implement simple wrappers that:

- Subscribe via `rpcSubs` to the relevant method.
- Accept a callback for updates.
- Return a small object describing the subscription, with an `unsubscribe()` function.

Example for account subscription:

```js
/**
 * Subscribe to account changes for a given pubkey.
 *
 * @param {*} rpcSubs - WebSocket client from createSolanaTrackerRPCClient
 * @param {string} pubkey
 * @param {(update: any) => void} onUpdate - called when the account changes
 * @param {Object} [opts] - subscription options per SolanaTracker docs
 * @returns {Promise<{subscriptionId: number, unsubscribe: () => Promise<void>}>}
 */
function createSubscribeAccount(rpcSubs) {
  return async function subscribeAccount(pubkey, onUpdate, opts) {
    // use rpcSubs + SolanaTracker's accountSubscribe / accountUnsubscribe
    // implementations and parameters derived from their docs
  };
}
```

Do the same for:

- `subscribeBlock` (blockSubscribe/blockUnsubscribe)
- `subscribeSlot` (slotSubscribe/slotUnsubscribe)
- `subscribeSlotsUpdates` (slotsUpdatesSubscribe/slotsUpdatesUnsubscribe)

The initial implementation can be minimal but **must** respect the documented params and response shapes from SolanaTracker.

---

## 5. Wire the HUD to use `rpcMethods`

Update `scripts/warchestService.js` to use the new methods library instead of guessing RPC internals.

Steps:

1. Import the new factory:

   ```js
   const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
   const { createRpcMethods } = require('../lib/solana/rpcMethods');
   ```

2. After creating the client:

   ```js
   const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
   const rpcMethods = createRpcMethods(rpc, rpcSubs);
   ```

3. Update the SOL fetch helpers:

   Replace the existing `fetchSolBalance(rpc, pubkey)` with something like:

   ```js
   async function fetchSolBalance(rpcMethods, pubkey) {
     if (!rpcMethods || typeof rpcMethods.getSolBalance !== 'function') return null;
     try {
       return await rpcMethods.getSolBalance(pubkey);
     } catch (err) {
       console.error('[HUD] Failed to fetch SOL balance for', pubkey, '-', err.message || err);
       return null;
     }
   }
   ```

   And then in `refreshAllSolBalances`, call:

   ```js
   const bal = await fetchSolBalance(rpcMethods, w.pubkey);
   ```

4. Keep all HUD behavior (state, render loop, shutdown) the same, just swap the underlying balance source to the new `getSolBalance`.

Do **not** introduce WebSocket subscriptions into HUD yet — we’re focusing on solid HTTP-based SOL balance via the new method library. WebSocket-powered HUD updates can be a later phase.

---

## 6. Style, error handling, tests, and docs

- Keep everything **CommonJS**.
- Use **JSDoc** for each exported factory and high-level method.
- **Unit tests (Jest) are required for every new RPC method file** you add:
  - Place tests under a sensible path like `tests/rpcMethods/`.
  - Mock the `rpc` / `rpcSubs` objects to mimic SolanaTracker’s behavior.
  - For example, test that `getSolBalance` correctly divides lamports by `1e9`.
- Documentation:
  - Update existing docs (e.g., `README.md`, `AGENTS.md`, or a dedicated RPC methods doc) to:
    - Explain the new RPC methods library conceptually.
    - List the main methods and their signatures.
    - Show how to import and use them in other modules (like HUD, dossier).
  - Keep the VAULT77 / Scoundrel vibe and tone in any new doc wording.

For error handling:

- Wrap RPC calls in `try/catch` inside each method.
- Throw meaningful errors for callers (e.g., `new Error('getSolBalance: failed to fetch balance: ' + err.message)`), OR return `null` when appropriate and document that in JSDoc.

---

## 7. Git commit strategy

I want granular history so I can see how each RPC method evolved.

- **Each new RPC method implementation should be its own git commit**, with:
  - A descriptive message, e.g.:
    - `feat(rpc): add getSolBalance helper`
    - `feat(rpc): add getTokenAccountsByOwnerV2 helper`
    - `feat(rpc): add subscribeAccount helper`
  - That commit should include:
    - The method implementation file in `lib/solana/rpcMethods/`.
    - Its corresponding Jest test file.
    - Any doc updates specifically related to that method (if applicable).

It’s okay to group small related changes (e.g., `getTokenAccountsByOwner` + `getTokenAccountsByOwnerV2`) in a single commit if they are tightly coupled, but the default should be **one method per commit**.

At the end, a final “wire-up” commit can adjust HUD or other modules to consume the new methods.

---

## 8. Things NOT to do

- Do **not** change the shape of `createSolanaTrackerRPCClient()`’s public API (existing exports, logging behavior, etc.).
- Do **not** convert files to ESM.
- Do **not** hardcode API keys or URLs; respect existing env usage.
- Do **not** mix DB logic into RPC methods; these should stay transport + parsing only.

---

## 9. When you’re done

- Summarize:
  - Files added (e.g., `lib/solana/rpcMethods/index.js`, etc.).
  - Files modified (especially `scripts/warchestService.js`).
  - The public API of `createRpcMethods` (list all methods and their signatures).
- Call out any assumptions you had to make about the SolanaTracker client shape.
- Confirm that:
  - All new RPC methods have unit test coverage.
  - Documentation has been updated to reflect the new architecture and APIs.
  - HUD now uses `rpcMethods.getSolBalance` and shows real SOL balances.

Your goal is that, after your changes:

```js
const { createSolanaTrackerRPCClient } = require('./lib/solanaTrackerRPCClient');
const { createRpcMethods } = require('./lib/solana/rpcMethods');

const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
const rpcMethods = createRpcMethods(rpc, rpcSubs);

const sol = await rpcMethods.getSolBalance('<some-wallet>');
```

returns a real SOL balance as a number, and adding a new RPC method in the future is as simple as:

- writing `lib/solana/rpcMethods/someNewMethod.js`,
- adding it to `createRpcMethods` in `index.js`,
- writing its Jest test,
- updating docs,
- and committing it with a descriptive git message.
