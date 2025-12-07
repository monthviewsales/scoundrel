You are working in my local repo `scoundrel`.
This project is a Node.js CLI (CommonJS) that talks to SolanaTracker.io RPC and Data APIs. It uses `@solana/kit` under the hood via a wrapper called `createSolanaTrackerRPCClient`.

Your task now:
Wire the warchest HUD worker to show real SPL token balances per wallet using the existing `rpcMethods` library, with proper deltas since HUD open.

We are doing Option A only:

- SOL balances are already working (via `getSolBalance`).
- The RPC methods library already exists (including `getTokenAccountsByOwnerV2`).
- HUD token rows are currently empty.
- No metadata (symbol/name) or prices yet — leave those for later tasks.

--------------------------------------------------
0. Project context & constraints
--------------------------------------------------

Important project rules:

- Code style:
  - CommonJS (`require`, `module.exports`), not ESM.
  - Node 22.x, `better-sqlite3`, `chalk`, `dotenv`.
  - Use JSDoc for any new helper functions you introduce in shared modules.
  - Keep code lint-friendly (ESLint).
- Do not:
  - Change the behavior or public API of `createSolanaTrackerRPCClient()`.
  - Change the RPC methods library API shape unless you absolutely must (and if you do, update tests accordingly).
  - Add DB/coins/Data API logic yet. This task uses only RPC for tokens.

We already have:

- `lib/solanaTrackerRPCClient.js` — wraps SolanaTracker RPC (HTTP + WebSocket) using `@solana/kit`.
- `lib/solana/rpcMethods/` — RPC façade from a previous task:
  - `index.js` with `createRpcMethods(rpc, rpcSubs)`.
  - `getSolBalance.js`, `getTokenAccountsByOwnerV2.js`, etc.
  - Internal helpers under `lib/solana/rpcMethods/internal/`.
- `scripts/warchestHudWorker.js` — HUD worker:
  - Already shows real SOL balances + Δ since open.
  - Renders a table for tokens but currently shows “(no tokens yet)”.

--------------------------------------------------
1. Read the relevant code first
--------------------------------------------------

Before you change anything, inspect:

1. `lib/solana/rpcMethods/getTokenAccountsByOwnerV2.js`
   - Understand:
     - The normalized return shape of the method.
     - How it unwraps SolanaTracker’s HTTP RPC response.
   - Also open its Jest test under `tests` or `__tests__/solana/rpcMethods/` to see exactly what the method returns (field names like `accounts`, `mint`, `uiAmount`, etc.).

2. `scripts/warchestHudWorker.js`
   - Understand:
     - The `WalletState` structure (look for its JSDoc).
     - How `buildInitialState()` sets up wallets.
     - How `refreshAllSolBalances()` works with `rpcMethods.getSolBalance`.
     - How `renderWalletSection()` consumes `wallet.tokens` (`TokenRow` type).
     - How the timers and `renderHud()` loop work.

3. (Optional) `lib/solana/rpcMethods/internal/tokenAccountNormalizer.js` (if present)
   - This may already describe how token accounts are normalized. Use it rather than reinventing.

Do not implement anything until you’re clear on:

- What `getTokenAccountsByOwnerV2` returns.
- What the HUD expects in `WalletState.tokens`.

--------------------------------------------------
2. HUD design for token balances (no metadata/prices yet)
--------------------------------------------------

We want the HUD to:

- For each wallet:
  - Show its current SPL token balances (from RPC) in the table.
  - Show a Δ since HUD open per token (based on the first snapshot after HUD starts).
- For this task:
  - Do not integrate the `coins` table or Data API.
  - Do not fetch token symbols/names from anywhere yet.
  - Do not compute USD estimates (keep `usdEstimate: null` or display `'-'`).

We will:

- Add fields to `WalletState` to track token baselines.
- Implement a `refreshAllTokenBalances()` helper in the HUD worker.
- Wire it into a periodic timer, similar to `refreshAllSolBalances()`.

--------------------------------------------------
3. Extend WalletState for tokens
--------------------------------------------------

In `scripts/warchestHudWorker.js`, find the JSDoc for `WalletState`. You should see something like:

/**
 * @typedef {Object} WalletState
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} color
 * @property {number|null} startSolBalance
 * @property {number} solBalance
 * @property {number} solDelta
 * @property {number} openedAt
 * @property {number} lastActivityTs
 * @property {TokenRow[]} tokens
 */

Extend this typedef to track a per-mint baseline for tokens:

- Add:

 * @property {Object<string, number>} startTokenBalances

so the typedef becomes:

 * @property {Object<string, number>} startTokenBalances
 * @property {TokenRow[]} tokens

Then in `buildInitialState(walletSpecs)`:

- Initialize `startTokenBalances` to `{}`.
- Ensure each wallet starts with `tokens: []` and `startTokenBalances: {}`.

--------------------------------------------------
4. Add a token refresh helper
--------------------------------------------------

Still in `scripts/warchestHudWorker.js`, implement a new helper:

/**
 * Refresh token balances for all wallets and update HUD state.
 * Uses rpcMethods.getTokenAccountsByOwnerV2.
 *
 * @param {*} rpcMethods
 * @param {Record<string, WalletState>} state
 * @returns {Promise<void>}
 */
async function refreshAllTokenBalances(rpcMethods, state) {
  // Implementation here
}

Behavior:

For each wallet (`alias` in `Object.keys(state)`):

1. Call:

   rpcMethods.getTokenAccountsByOwnerV2(wallet.pubkey, opts)

   where `opts` should be derived from the current implementation & tests.

   - Start with options like `excludeZero` / `limit` if those exist; do not invent new options. Use the method’s documented and tested API.

2. From the result, get the normalized accounts array:

   - e.g. `const accounts = result.accounts || result.value || []` — use the actual field names from the rpcMethods implementation/tests.
   - Each account should already be normalized by the method library (check its tests).

3. For each token account:

   - Determine:
     - `mint` (string).
     - `amount` as a float (likely `uiAmount` or similar; confirm from tests).

   - Use `wallet.startTokenBalances[mint]` as the baseline:
     - If it doesn’t exist yet, set it to the current amount.
     - Then compute:

       const delta = amount - start;

4. Build `TokenRow` objects for each token.

   Look up the `TokenRow` typedef in the HUD worker; it should be something like:

   /**
    * @typedef {Object} TokenRow
    * @property {string} symbol
    * @property {string} mint
    * @property {number} balance
    * @property {number} deltaSinceOpen
    * @property {number|null} usdEstimate
    */

   For now:

   - `symbol` → `''` (empty string) or `acct.symbol || ''` if already present in the normalized token account.
   - `mint` → token mint address from the account.
   - `balance` → `amount` (uiAmount-style).
   - `deltaSinceOpen` → computed delta.
   - `usdEstimate` → `null` (we’ll wire this when we add prices).

5. Assign:

   wallet.tokens = tokenRows;
   wallet.lastActivityTs = now;

Handle errors per wallet:

- Wrap each wallet’s fetch in a try/catch.
- On error, log something like:

  console.error('[HUD] Failed to fetch tokens for', wallet.alias, wallet.pubkey, '-', err.message || err);

…but do not throw out of the whole `refreshAllTokenBalances`; keep HUD running.

--------------------------------------------------
5. Add a token refresh timer + env setting
--------------------------------------------------

At the top of `warchestHudWorker.js`, we already have:

const HUD_RENDER_INTERVAL_MS = intFromEnv('HUD_RENDER_INTERVAL_MS', 750);
const HUD_SOL_REFRESH_SEC = intFromEnv('HUD_SOL_REFRESH_SEC', 15);

Add a token refresh interval:

const HUD_TOKENS_REFRESH_SEC = intFromEnv('HUD_TOKENS_REFRESH_SEC', 30);

In `main()`:

1. After the initial SOL refresh:

   await refreshAllSolBalances(rpcMethods, state);

   Add an initial token refresh:

   await refreshAllTokenBalances(rpcMethods, state);

2. Add a periodic token timer:

   const tokenTimer = setInterval(() => {
     refreshAllTokenBalances(rpcMethods, state).catch((err) => {
       console.error('[HUD] Error refreshing token balances:', err.message || err);
     });
   }, HUD_TOKENS_REFRESH_SEC * 1000);

3. In the shutdown function, clear it:

   function shutdown() {
     clearInterval(solTimer);
     clearInterval(tokenTimer);
     clearInterval(renderTimer);
     Promise.resolve()
       .then(() => close())
       .catch(() => {})
       .finally(() => process.exit(0));
   }

The render loop (`renderHud(state)`) should not need major changes, as long as `tokens` is populated with `TokenRow[]`.

--------------------------------------------------
6. Keep everything RPC-only for now
--------------------------------------------------

For this task:

- Do not:
  - Touch the `coins` table or any DB code.
  - Call the SolanaTracker Data API.
  - Add prices or metadata resolution.
  - Introduce WebSocket subscriptions.

We are only filling the HUD’s token table using HTTP RPC methods.

--------------------------------------------------
7. Sanity checks / internal QA
--------------------------------------------------

Before you consider this task done:

1. Run the HUD worker manually with real wallets that hold SPL tokens, e.g.:

   node scripts/warchestHudWorker.js \
     --wallet warlord:DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR:green \
     --wallet scooby:D2xBFAiwVBnV7xnmqvdFLuL62qesi7kCNVyT4rZwfNua:magenta

2. Confirm:
   - SOL header line shows real balances (already working from prior task).
   - The token table under each wallet now shows:
     - At least 1–2 token rows if those wallets hold tokens.
     - Balance values that roughly match what you see in a Solana explorer.
     - Δ since open starts at 0 and moves only when balances change (if you trade while HUD is running).

3. Make minimal adjustments if the `getTokenAccountsByOwnerV2` result shape differs from what you initially assumed, but keep all adaptation logic inside `refreshAllTokenBalances`, not in callers.

Document any assumptions about the rpcMethods return shape via comments if needed.

--------------------------------------------------
8. Things NOT to do
--------------------------------------------------

- Do not modify `lib/solanaTrackerRPCClient.js`.
- Do not change the function signature of `createRpcMethods(...)`.
- Do not change the exported API of any existing RPC helper unless absolutely necessary (and if you do, update its tests).
- Do not pull prices or metadata in this task.

--------------------------------------------------
9. When you’re done
--------------------------------------------------

- Summarize:
  - What changes you made to `scripts/warchestHudWorker.js`.
  - How `refreshAllTokenBalances` works and what it expects from `getTokenAccountsByOwnerV2`.
  - What new env var you added (`HUD_TOKENS_REFRESH_SEC`) and its default.
- Confirm:
  - HUD shows real SPL tokens per wallet.
  - Δ since open for tokens is correct based on the first snapshot.
  - No changes were made to RPC methods APIs beyond what was strictly necessary to support this.

Your goal is that, after your changes, I can run:

node scripts/warchestHudWorker.js \
  --wallet ScoobyCarolan:D2xBFAiwVBnV7xnmqvdFLuL62qesi7kCNVyT4rZwfNua:green

…and see real SPL tokens listed under the wallet, with balances and deltas updating over time (no prices or symbols yet).

Everything else (metadata, prices, subscriptions) will be separate tasks.
# Scoundrel Codex Task: HUD Token Balances (Option A)

You are working in my local repo **`scoundrel`**. This project is a Node.js CLI (CommonJS) that talks to **SolanaTracker.io** RPC and Data APIs. It uses `@solana/kit` under the hood via a wrapper called `createSolanaTrackerRPCClient`.

Your task now is to **wire the Warchest HUD Worker to show real SPL token balances per wallet** using the existing `rpcMethods` library, with correct delta calculations from HUD start.

This task is **Option A only** — no metadata resolution, no prices, no Data API, no subscriptions.

---
## 0. Project Context & Constraints

### Important project rules:
- Write **CommonJS** (using `require` / `module.exports`).
- Node 22.x environment.
- Use `better-sqlite3`, `chalk`, `dotenv` — already installed.
- Use **JSDoc** for any new helper you introduce.
- Maintain ESLint-friendly code.

### Do *not*:
- Modify `createSolanaTrackerRPCClient()` behavior or public API.
- Change RPC method signatures unless absolutely required.
- Add **DB**, **coins table**, or **Data API** logic.
- Add pricing or metadata lookup.
- Add WebSocket subscriptions.

### Currently in the repo:
- `lib/solanaTrackerRPCClient.js` — SolanaTracker RPC wrapper.
- `lib/solana/rpcMethods/` — façade with: 
  - `getSolBalance.js`
  - `getTokenAccountsByOwnerV2.js`
  - normalization helpers under `internal/`
- `scripts/warchestHudWorker.js` — the HUD worker script.
  - Already shows **SOL balances + SOL deltas**.
  - Token table still empty.

---
## 1. Read the Relevant Code First

Before writing anything, study:

### 1. `lib/solana/rpcMethods/getTokenAccountsByOwnerV2.js`
- Learn the **normalized return shape**.
- Review its associated **Jest test** to understand guaranteed fields.

### 2. `scripts/warchestHudWorker.js`
Understand:
- `WalletState` JSDoc
- `buildInitialState()`
- `refreshAllSolBalances()`
- `renderWalletSection()` and how it uses `wallet.tokens`
- Render + timer loop architecture

### 3. Optional: token normalizer
`lib/solana/rpcMethods/internal/tokenAccountNormalizer.js` may already define the normalized SPL token account shape.

---
## 2. HUD Token Design (No Metadata or Prices Yet)

The HUD must:
- Show **current SPL token balances** pulled via RPC.
- Show **Δ since open** for each token.

This task deliberately **does NOT**:
- Resolve metadata (symbol, decimals, etc.).
- Call the Data API.
- Fetch USD prices.

We will:
- Extend `WalletState` to track token baselines.
- Add `refreshAllTokenBalances()`.
- Add a recurring token refresh timer.

---
## 3. Extend `WalletState` for Tokens

In `scripts/warchestHudWorker.js`, update the `WalletState` typedef to include:

```js
@property {Object<string, number>} startTokenBalances
```

This becomes:

```js
@property {Object<string, number>} startTokenBalances
@property {TokenRow[]} tokens
```

Then update `buildInitialState(walletSpecs)` to set:

```js
startTokenBalances: {},
tokens: [],
```

---
## 4. Implement `refreshAllTokenBalances()`

Create this new helper inside `scripts/warchestHudWorker.js`:

```js
/**
 * Refresh token balances for all wallets and update HUD state.
 * Uses rpcMethods.getTokenAccountsByOwnerV2.
 * @param {*} rpcMethods
 * @param {Record<string, WalletState>} state
 * @returns {Promise<void>}
 */
async function refreshAllTokenBalances(rpcMethods, state) {
  // Implementation goes here
}
```

### Behavior Per Wallet
1. Call the RPC method:
   ```js
   rpcMethods.getTokenAccountsByOwnerV2(wallet.pubkey, opts)
   ```
   - Use the correct `opts` shape from the existing method/tests.

2. Extract the normalized token accounts array:
   ```js
   const accounts = result.accounts || [];
   ```

3. For each account:
   - Extract `mint` and `amount` (`uiAmount` from the normalized account; verify via tests).
   - Determine baseline:
     ```js
     const start = wallet.startTokenBalances[mint] ?? amount;
     wallet.startTokenBalances[mint] = start;
     const delta = amount - start;
     ```

4. Build a `TokenRow` object:
   ```js
   {
     symbol: '',           // or acct.symbol if the rpcMethods normalizer already includes it
     mint,
     balance: amount,
     deltaSinceOpen: delta,
     usdEstimate: null     // pricing comes later
   }
   ```

5. Save:
   ```js
   wallet.tokens = tokenRows;
   wallet.lastActivityTs = Date.now();
   ```

6. Wrap each wallet’s operation in try/catch; log errors but don’t crash HUD.

---
## 5. Add Token Refresh Timer and ENV Setting

At the top of `warchestHudWorker.js`, add:

```js
const HUD_TOKENS_REFRESH_SEC = intFromEnv('HUD_TOKENS_REFRESH_SEC', 30);
```

Inside `main()`:
1. After initial SOL load:
   ```js
   await refreshAllTokenBalances(rpcMethods, state);
   ```

2. Add periodic timer:
   ```js
   const tokenTimer = setInterval(() => {
     refreshAllTokenBalances(rpcMethods, state).catch((err) => {
       console.error('[HUD] Error refreshing token balances:', err.message || err);
     });
   }, HUD_TOKENS_REFRESH_SEC * 1000);
   ```

3. Add `clearInterval(tokenTimer)` in `shutdown()`.

No changes needed to the render loop as long as `wallet.tokens` is populated.

---
## 6. RPC-Only Scope (Important)

Do **not**:
- Query the coins table.
- Pull token metadata.
- Fetch prices.
- Add WebSocket subscriptions.

This task ONLY uses SolanaTracker RPC HTTP endpoints.

---
## 7. Sanity Checks

Before finishing:

1. Run HUD with real wallets containing SPL tokens:

```bash
node scripts/warchestHudWorker.js \
  --wallet warlord:<PUBKEY>:green \
  --wallet scooby:<PUBKEY>:magenta
```

2. Verify:
- SOL header shows correct balances.
- Token table displays real SPL tokens.
- Balances match explorers.
- Δ since open = 0 initially, changes when balances change.

3. If RPC result shapes differ slightly from expectations, update `refreshAllTokenBalances` ONLY.

---
## 8. Things *Not* To Do

- Do not modify `createSolanaTrackerRPCClient`.
- Do not change `createRpcMethods` signatures.
- Do not change RPC helper APIs unless required (and update tests accordingly).
- Do not integrate prices or metadata.
- Do not touch the DB.

---
## 9. Completion Requirements

When finished:
- Summarize changes made to `scripts/warchestHudWorker.js`.
- Explain how `refreshAllTokenBalances` works.
- Confirm the behavior of `HUD_TOKENS_REFRESH_SEC`.
- Confirm:
  - HUD shows real SPL token balances.
  - Δ since open is correct.
  - No RPC API changes were made unnecessarily.

Your goal is that running:

```bash
node scripts/warchestHudWorker.js --wallet mywallet:<PUBKEY>:green
```

…shows real SPL token balances with deltas updating over time (no symbol or USD yet).

--- END NEW CONTENT ---