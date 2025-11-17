# Scoundrel Autopsy Feature Prompt

You are working in my local repo **`scoundrel`**.  
This project is a Solana Blockchain data backbone built in a Node.js CLI (CommonJS) that talks to **SolanaTracker.io** RPC and Data APIs via a wrapper called `createSolanaTrackerDataClient` (for Data API and uses @solana-tracker/data-api) and `createSolanaRpc` (for RPC which relies on @solana/kit).  

Your task:  
**Design and implement a modular “trade autopsy” feature** that analyzes a single mint’s “campaign” (all trades of that token in a wallet), calls OpenAI via our existing AI client, and produces a post-mortem on that trade.  

Requirements:  

1. **Input**:  
   - Wallet address (string)  
   - Mint address (string)  

2. **Data Gathering**:  
   - Fetch all trades involving the wallet and the mint.  
   - Include both buys and sells, with timestamps, prices, and quantities.  
   - Use the existing `createSolanaTrackerDataClient` to query the Data API for this information.  

3. **Analysis**:  
   - Summarize the trade campaign: total bought, total sold, average buy price, average sell price, net position.  
   - Identify key events: first buy, last sell, biggest trade, etc.  
   - Detect any unusual patterns or risks (e.g., buying after a large price drop).  

4. **AI Integration**:  
   - Use the existing AI client (it is imported as `/ai/client.js`) to generate a narrative post-mortem.  
   - Provide the AI with the summarized data and key events as context.  
   - The narrative should include insights, potential mistakes, and suggestions.  

5. **Output**:  
   - Return a structured object containing:  
     - The raw trade data array  
     - The summarized statistics  
     - The AI-generated narrative string  

6. **Modularity**:  
   - The feature should be implemented as a function `runTradeAutopsy(walletAddress, mintAddress)` exported from a new file `/lib/tradeAutopsy.js`.  
   - The function should be asynchronous and handle errors gracefully.  

7. **Testing**:  
   - Include a simple CLI command or script to run the autopsy for a given wallet and mint, printing the narrative to stdout.  

8. **Documentation**:  
   - Document the function with JSDoc comments.  
   - Add a README section describing the feature and usage.  

Constraints:  
- Use only existing dependencies in the repo or standard Node.js modules.  
- Follow existing code style and conventions (CommonJS, async/await).  
- Do not hardcode API keys or secrets; assume they are configured externally.  
- Keep the AI prompt concise but informative.  

Deliverables:  
- `/lib/tradeAutopsy.js` with the implemented function.  
- CLI script or command to invoke the feature.  
- README update with usage instructions.
- Unit testing via Jest

Please proceed with the design and implementation accordingly.

# Scoundrel Autopsy Feature Prompt

You are working in my local repo **`scoundrel`**.  
This project is a Solana Blockchain data backbone built as a Node.js CLI (CommonJS) that talks to **SolanaTracker.io** RPC and Data APIs. It uses `@solana/kit` under the hood via wrappers like `createSolanaTrackerDataClient` (Data API) and `createSolanaRpc` (RPC).

Your task:

**Design and implement a modular `autopsy` feature** that analyzes a single mint’s **campaign** (all trades of that token in a wallet), calls OpenAI via our existing AI client, and produces a structured post‑mortem on that trade.  

We already have a **dossier** feature that builds a trader profile.  
`autopsy` is its sibling: instead of “who is this trader?”, it answers **“how did this specific trade (campaign) perform and what should I learn from it?”**

You have:

- Repo files (via VS Code)
- The Solana MCP server
- SolanaTracker Data API docs
- Existing AI jobs and dossier plumbing as reference

---

## 0. Project constraints & conventions

Follow these existing rules:

- **CommonJS** only (`require`, `module.exports`), not ESM
- Use **JSDoc** for exported functions
- Keep code **ESLint‑friendly**
- Reuse existing modules rather than rewriting them:
  - `index.js` — CLI entrypoint & command wiring
  - `lib/solanaTrackerClient.js` — SolanaTracker Data API wrapper
  - DB layer / BootyBox helpers — for the `coins` table
  - `commands/dossier.js` or `lib/dossier.js` — existing data + AI feature
  - `ai/jobs/*` — existing OpenAI job definitions

The new **autopsy** feature must:

- Be runnable via CLI as:

  ```bash
  scoundrel autopsy
  ```

- Reuse dossier‑style data gathering and AI patterns
- Save a structured JSON artifact that Warlord AI can ingest later
- Produce a coach‑style post‑mortem (not just raw numbers)

---

## 1. Files to read before coding

Before writing code, open and understand:

### 1.1 `index.js`

- How commands (e.g., `dossier`) are registered and invoked
- How arguments/flags are parsed

### 1.2 `lib/dossier.js`

- How dossier:
  - Resolves wallets
  - Uses `createSolanaDataTrackerClient`
  - Builds JSON payloads
  - Calls AI
  - Logs/saves outputs

### 1.3 `lib/solanaTrackerDataClient.js`

- How SolanaTracker Data API calls are wrapped
- Which helpers already exist for:
  - `getWalletTrades`
  - Token info
  - Price/PNL endpoints
  - Any existing candle/OHLCV endpoint wrappers

### 1.4 DB layer / coins table

- How MySQL (or BootyBox) is used
- How the `coins` table is defined and accessed
  - Fetch by mint
  - Insert / upsert token metadata

### 1.5 AI job files under `ai/jobs/*`

- How a job:
  - Defines its system instructions
  - Receives input payloads
  - Calls the OpenAI / Responses API
  - Structures JSON output

Do **not** code until you understand how dossier is wired end‑to‑end.

---

## 2. SolanaTracker Data API: required methods

Use the **SolanaTracker Data API** via `createSolanaDataTrackerClient`.  
Study the docs and confirm behavior for at least these methods:

- `getWalletTrades(walletAddress)`
  - Used to retrieve the wallet’s trade history, to be filtered by mint
- `getTokenInfo(tokenAddress)`
  - Fetches metadata (symbol, name, decimals, etc.)
- `getPriceRange(tokenAddress, fromTimestamp, toTimestamp)`
  - Lowest and highest price in a given time range
- `getTokenPnL(walletAddress, tokenAddress, holdingCheck)`
  - Use `holdingCheck = true`
  - Returns realized PnL and related metrics for that token in that wallet
- `getAthPrice(tokenAddress)`
  - All‑time high price for the token
- **Candles / OHLCV endpoint**
  - Identify and use the endpoint that provides OHLCV candles (e.g., 1‑minute)

  Our SolanaTracker Data SDK is located at this GitHub repo if you need addityional info: https://github.com/solanatracker/data-api-sdk

Make sure you know:

- Request parameters and types
- Response shapes
- Any rate limits / quirks noted in the docs

---

## 3. CLI feature: `scoundrel autopsy`

### 3.1 High‑level flow

Add a new CLI command:

```bash
scoundrel autopsy
```

Interactive flow:

1. **Wallet selection (HUD wallets + “Other”)**
   - Query the existing **HUD wallet registry** or equivalent source used by dossier/HUD.
   - Display something like:

     ```text
     Which wallet?
     1) warlord (F...abc)
     2) sniper  (C...def)
     3) cold    (G...xyz)
     4) Other (enter address)
     >
     ```

   - If the user selects a HUD wallet:
     - `walletLabel` = friendly label (e.g., `"warlord"`)
     - `walletAddress` = pubkey
   - If the user selects **Other**:
     - Prompt: `Enter wallet address:`
     - `walletLabel = 'other'` (or similar)
     - `walletAddress` = entered pubkey

2. **Mint input**

   Prompt:

   ```text
   Enter mint to trace:
   >
   ```

   - Validate non‑empty, basic base58 format check is optional but nice.

3. **Orchestrator call**

   Call a new function in `lib/autopsy.js`:

   ```js
   const { runAutopsy } = require('./lib/autopsy');

   await runAutopsy({ walletLabel, walletAddress, mint });
   ```

---

## 4. Campaign construction

A **campaign** is defined as:  
> All trades of a given mint for a given wallet.

### 4.1 Ensure token metadata exists (`coins` table)

1. Query the `coins` table for the mint.
   - Use an existing helper if one exists, otherwise add one in the DB module.
2. If **no row** exists:
   - Call `getTokenInfo(mint)` via the Data API.
   - Insert that token metadata into `coins`.
3. Result: you have a `tokenInfo` object containing:
   - `mint`
   - `symbol`
   - `name`
   - `decimals`
   - Any other SolanaTracker fields you want to pass through

### 4.2 Fetch and filter wallet trades

1. Fetch trades:

   ```js
   const allTrades = await client.getWalletTrades(walletAddress);
   ```

2. Filter to this mint:

   ```js
   const mintTrades = allTrades.filter(t => t.mint === mint);
   ```

3. If `mintTrades.length === 0`:
   - Print a friendly message and exit gracefully.

### 4.3 Campaign time window

Compute:

```js
const startTimestamp = Math.min(...mintTrades.map(t => t.timestamp));
const endTimestamp = Math.max(...mintTrades.map(t => t.timestamp));
```

You may optionally pad time bounds later, but v1 can be tight around the campaign.

### 4.4 Campaign metrics

From `mintTrades` and/or `getTokenPnL`, compute:

- `realizedPnLSol`
- `realizedPnLPercent`
- `avgEntryPrice`
- `avgExitPrice`
- `holdDurationSeconds` (first buy → last sell)
- `maxPriceAfterEntry` (within campaign window)
- `minPriceAfterEntry` (within campaign window)
- `feesPaidSol`
- `feeToPnLRatio`

Keep math deterministic and simple.  
Store these under `campaign.metrics`.

---

## 5. Market context (SolanaTracker)

Using the Data API client:

1. `priceRange = await client.getPriceRange(mint, startTimestamp, endTimestamp)`
   - Contains lowest and highest price over the campaign.

2. `tokenPnL = await client.getTokenPnL(walletAddress, mint, true)`
   - `holdingCheck = true`
   - Should reflect realized PnL and possibly additional info.

3. `athPrice = await client.getAthPrice(mint)`
   - All‑time high price.

These become part of `marketContext` in the payload.

---

## 6. OHLCV candle window

We want the AI to see local price action around the campaign.  

1. Define a window:

   ```js
   const windowStart = startTimestamp - 300; // 5 minutes before
   const windowEnd   = endTimestamp + 300;   // 5 minutes after
   ```

2. Fetch 1‑minute candles for `[windowStart, windowEnd]` using the appropriate SolanaTracker endpoint.

3. Implement **guardrails**:
   - If the campaign is very long, avoid sending thousands of candles.
   - Options:
     - Cap the number of candles (e.g., 300–500 max)
     - Downsample (e.g., take every Nth candle)
     - Fall back to a higher timeframe (e.g., 5m) for very long windows

4. Represent result as:

   ```js
   const ochlvWindow = {
     granularity: '1m',
     startTimestamp: windowStart,
     endTimestamp: windowEnd,
     candles: [
       // Array of compact objects, e.g.: { t, o, h, l, c, v }
     ]
   };
   ```

Include this under `marketContext.ochlvWindow`.

---

## 7. Autopsy payload structure

Build a **single payload object** that will be both:

- Input to the AI job, and
- The core of the persisted autopsy JSON file.

Suggested shape:

```js
const payload = {
  wallet: {
    label: walletLabel,
    address: walletAddress
  },
  token: {
    mint,
    symbol: tokenInfo.symbol,
    name: tokenInfo.name,
    decimals: tokenInfo.decimals,
    tokenInfo // raw or normalized tokenInfo from SolanaTracker
  },
  campaign: {
    trades: mintTrades,
    startTimestamp,
    endTimestamp,
    metrics: {
      realizedPnLSol,
      realizedPnLPercent,
      avgEntryPrice,
      avgExitPrice,
      holdDurationSeconds,
      maxPriceAfterEntry,
      minPriceAfterEntry,
      feesPaidSol,
      feeToPnLRatio
    }
  },
  marketContext: {
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow
  },
  meta: {
    createdAt: new Date().toISOString(),
    scoundrelVersion: <version_if_available>,
    command: 'autopsy'
  }
};
```

Keep keys compact but clear.  
Avoid duplicating the same data in multiple places.

---

## 8. AI job: `ai/jobs/tradeAutopsy.js`

Create a new AI job module:

- **File:** `ai/jobs/tradeAutopsy.js`

### 8.1 Purpose

This job is Warlord’s **trade autopsy engine**.  
Given the payload above, it produces a structured post‑mortem:

- How good/bad the **entries** were
- How good/bad the **exits** were
- How risk was managed
- How realistic the realized PnL was vs what was reasonably available
- Concrete lessons and tags for future learning
- A simple grade

### 8.2 System instructions

Define a system prompt similar to other jobs, e.g.:

> You are Warlord’s trade autopsy engine.  
> You receive JSON describing a single “campaign” in one token for one wallet, including all trades, realized PnL, metrics, price range, token PnL, all-time high, and a window of OHLCV candles around the campaign.  
>  
> Your job is to perform a realistic **post-mortem** of how the campaign was executed:
> - Judge the quality of **entries** and **exits** relative to the price action.
> - Identify what the trader did **well**.
> - Identify **mistakes** (e.g., chased pumps, cut winners early, bagheld, oversized).
> - Propose **specific, concrete changes** that would have improved profitability or reduced risk, without relying on perfect hindsight.
>  
> Assume the trader is an active Solana memecoin degen who understands basic trading concepts. Keep your tone direct, practical, and slightly degen-friendly without being cringe.  
>  
> **Constraints:**
> - Use the provided numbers and candles; do not invent prices or timestamps.
> - Respect liquidity and execution realism.
> - Feedback should be **coaching**, not shaming.

### 8.3 Output schema

Enforce a strict JSON output contract, for example:

```js
{
  grade: "B-",            // string: A, A-, B+, B, B-, C+, etc.
  summary: "...",         // 1–3 sentence overview
  entryAnalysis: "...",   // how entries matched price action
  exitAnalysis: "...",    // how exits matched price action
  riskManagement: "...",  // sizing, drawdown handling, stops
  profitability: "...",   // realized PnL vs available opportunity
  lessons: [              // 2–5 short, concrete lessons
    "First lesson...",
    "Second lesson..."
  ],
  tags: [                 // 2–8 snake_case tags
    "cut_winner_early",
    "chased_pump",
    "respected_stop"
  ]
}
```

In the prompt, instruct the model:

> Respond **only** with a JSON object matching this schema.  
> Do not include markdown or any additional commentary.

Wire this job into the existing AI client just like other jobs.

---

## 9. Implementing `lib/autopsy.js`

Create a new module:

```js
// lib/autopsy.js

/**
 * Run a trade autopsy for a single wallet + mint campaign.
 *
 * @param {Object} params
 * @param {string} params.walletLabel   Human-friendly label or "other".
 * @param {string} params.walletAddress Base58 wallet pubkey.
 * @param {string} params.mint          Token mint address.
 * @returns {Promise<void>}
 */
async function runAutopsy({ walletLabel, walletAddress, mint }) {
  // implementation
}

module.exports = { runAutopsy };
```

Inside `runAutopsy`:

1. Instantiate the SolanaTracker Data API client.
2. Ensure token info exists in the `coins` table; fetch or insert via `getTokenInfo`.
3. Fetch wallet trades, filter to the mint, and build campaign metrics.
4. Fetch `priceRange`, `tokenPnL`, `athPrice`, and the OHLCV candle window.
5. Assemble the full payload object.
6. Call the `tradeAutopsy` AI job with that payload.
7. Persist the resulting autopsy JSON to disk.
8. Print a concise summary to the CLI using `chalk` with tasteful VAULT77 flavor.

### 9.1 Autopsy JSON file path & structure

Save autopsy outputs under:

- Directory: `./autopsy/<walletLabel>/`
- Filename pattern:

  ```text
  autopsy-<walletLabel>-<mint>-<timestamp>.json
  ```

Example:

```text
./autopsy/warlord/autopsy-warlord-GtL1QDLS6XAbf56KykH35m2QTWGkuebnrQpBcaFNpump-1763231234.json
```

Suggested file content:

```js
{
  wallet: { ... },
  token: { ... },
  campaign: { ... },
  marketContext: { ... },
  aiResult: { ... },   // output from tradeAutopsy job
  meta: {
    createdAt: '2025-11-15T12:34:56.789Z',
    scoundrelVersion: 'x.y.z',
    command: 'autopsy'
  }
}
```

### 9.2 CLI summary output

After saving the file, print a short, readable summary, e.g.:

```text
💀 AUTOPSY COMPLETE: warlord on 2Z (GtL1QDL...)

PnL: +0.42 SOL (+23.5%) over 38 minutes
Grade: B-
Key takeaway: Cut winner early; solid risk control, but left upside on table.

Saved: ./autopsy/warlord/autopsy-warlord-GtL1QDL...-1763231234.json
```

Use `chalk` for emphasis, but keep output compact and non‑spammy.

### 9.3 Error handling

For each major stage (DB, Data API, AI, file IO):

- Wrap with `try/catch`.
- Include contextual info in errors (wallet label, address, mint, stage name).
- Fail gracefully when possible and inform the user.

---

## 10. Wiring the CLI in `index.js`

In `index.js`:

1. Import:

   ```js
   const { runAutopsy } = require('./lib/autopsy');
   ```

2. Register the `autopsy` command using the same pattern as `dossier`:

   - Prompt for wallet (HUD + Other)
   - Prompt for mint
   - Call `runAutopsy({ walletLabel, walletAddress, mint })`

3. Ensure help text (`-h` / `--help`) lists `autopsy` and describes it briefly.

---

## 11. Tests (Jest)

Add tests for `lib/autopsy.js`:

- Mock:
  - SolanaTracker Data API client:
    - `getWalletTrades`
    - `getTokenInfo`
    - `getPriceRange`
    - `getTokenPnL`
    - `getAthPrice`
    - candles endpoint
  - DB helpers for `coins`
  - `tradeAutopsy` AI job

- Verify:
  - Campaign payload is built correctly for a simple scenario.
  - Behavior when the `coins` row exists vs missing (ensure `getTokenInfo` is called only when needed).
  - Behavior when there are **no trades** for the mint (graceful exit without file write).
  - Candle window logic respects caps/guardrails.
  - Output file path and naming convention is correct.
  - `aiResult` is included in the saved JSON.

You do not need exhaustive payload snapshots, but assert key structure and fields.

---

## 12. Documentation

Update or add docs:

- `README.md` — add a short **Autopsy** section:
  - What it does
  - Example usage
- `AGENTS.md` or `docs/autopsy.md` — more detail for agents/humans:
  - CLI workflow
  - JSON output shape
  - How Warlord AI is expected to consume these files later

Keep tone consistent with **VAULT77 / Scoundrel** (fun but clear).

---

## 13. Git commit strategy

Use clear, incremental commits, for example:

- `feat(autopsy): add CLI wiring and autopsy orchestrator`
- `feat(autopsy): add tradeAutopsy AI job`
- `test(autopsy): add Jest coverage for runAutopsy`
- `docs(autopsy): document autopsy command and JSON output`

When done, I should be able to run:

```bash
scoundrel autopsy
```

- Select `warlord` (or “Other” and paste a wallet)
- Enter a mint
- Receive:
  - A clean CLI summary (PnL, grade, key takeaway)
  - A JSON file saved under `./autopsy/<walletLabel>/` containing the full payload and AI result.
# Scoundrel Autopsy Feature – Codex Task Prompt

You are working in my local repo **`scoundrel`**.

Scoundrel is a Solana blockchain data backbone implemented as a Node.js CLI (CommonJS). It talks to **SolanaTracker.io** RPC and Data APIs via:

- `createSolanaTrackerDataClient` (Data API, uses `@solana-tracker/data-api`)
- `createSolanaRpc` (RPC, uses `@solana/kit`)

Your job is to **design and implement a modular `autopsy` feature** that:

- Analyzes a single mint’s **campaign** (all trades of that token in a wallet)
- Calls OpenAI via the existing AI client
- Produces a structured, coach-style post‑mortem on that trade
- Saves a JSON artifact that other tools (like Warlord AI) can ingest later

`autopsy` is the sibling of the existing **dossier** feature:
- **dossier** = “Who is this trader?”
- **autopsy** = “How did this specific campaign perform and what should I learn from it?”

---

## 0. General rules (follow these for all work)

- **CommonJS only** (`require`, `module.exports`), no ESM.
- Use **JSDoc** on exported functions.
- Keep everything **ESLint‑friendly** and consistent with existing style.
- Reuse existing modules and patterns instead of inventing new ones:
  - `index.js` — CLI entrypoint & command wiring
  - `commands/dossier.js` / `lib/dossier.js` — data + AI pattern
  - `lib/solanaTrackerClient.js` — SolanaTracker Data API wrapper
  - DB layer / BootyBox helpers — especially the `coins` table
  - `ai/jobs/*` — existing OpenAI job definitions and wiring
- Do **not** hardcode API keys or secrets; assume they are configured externally.
- Prefer small, focused functions; handle errors explicitly.

When you make code changes:
- Edit existing files where possible instead of creating parallel plumbing.
- Keep commits conceptually small (you can group multiple edits in the same logical change).

---

## 1. Files to understand before coding

Before writing or changing code, **open and read** these files and follow their patterns:

1. **`index.js`**
   - How commands (e.g., `dossier`) are registered and invoked
   - How arguments/flags are parsed

2. **`commands/dossier.js` or `lib/dossier.js`**
   - How dossier:
     - Resolves wallets
     - Uses `createSolanaTrackerClient`
     - Builds JSON payloads
     - Calls AI
     - Logs/saves outputs

3. **`lib/solanaTrackerClient.js`**
   - How SolanaTracker Data API calls are wrapped
   - Existing helpers for:
     - `getWalletTrades`
     - Token info
     - Price/PNL endpoints
     - Any candle / OHLCV wrappers

4. **DB layer / `coins` table**
   - How MySQL / BootyBox access is structured
   - How the `coins` table is defined and accessed (by mint, insert/upsert metadata)

5. **`ai/jobs/*`**
   - How a job defines **system instructions**
   - How it receives input payloads
   - How it calls the OpenAI / Responses API
   - How JSON output is structured and validated

Use these as templates for the **autopsy** feature. Do not diverge from existing patterns unless strictly necessary.

---

## 2. SolanaTracker Data API – required methods

Use **SolanaTracker Data API** via `createSolanaTrackerClient`. Study and rely on at least these methods:

- `getWalletTrades(walletAddress)`
  - Retrieve wallet trade history, to be filtered by mint.
- `getTokenInfo(tokenAddress)`
  - Fetch metadata: symbol, name, decimals, etc.
- `getPriceRange(tokenAddress, fromTimestamp, toTimestamp)`
  - Lowest and highest price over a given range.
- `getTokenPnL(walletAddress, tokenAddress, holdingCheck)`
  - Call with `holdingCheck = true`.
  - Returns realized PnL and related metrics for that token in that wallet.
- `getAthPrice(tokenAddress)`
  - All‑time high price.
- Candles / OHLCV endpoint
  - Whatever existing helper is used to fetch OHLCV candles.

Make sure you know:

- Request parameters and types
- Response shapes
- Any relevant quirks

Reuse existing helper wrappers where possible.

---

## 3. CLI feature: `scoundrel autopsy`

Add a new CLI command:

```bash
scoundrel autopsy
```

### 3.1 Interactive flow

1. **Wallet selection (HUD wallets + "Other")**
   - Query the same **HUD wallet registry** (or equivalent) used by dossier/HUD.
   - Present something like:

     ```text
     Which wallet?
     1) warlord (F...abc)
     2) sniper  (C...def)
     3) cold    (G...xyz)
     4) Other (enter address)
     >
     ```

   - If the user selects a HUD wallet:
     - `walletLabel` = friendly label (e.g., `"warlord"`)
     - `walletAddress` = pubkey
   - If the user selects **Other**:
     - Prompt: `Enter wallet address:`
     - `walletLabel = 'other'` (or similar)
     - `walletAddress` = entered pubkey

2. **Mint input**

   Prompt:

   ```text
   Enter mint to trace:
   >
   ```

   - Validate that it is non‑empty.
   - A basic base58 format check is optional, but nice.

3. **Autopsy orchestrator**

   Wire the command to a new orchestrator function in `lib/autopsy.js`:

   ```js
   const { runAutopsy } = require('./lib/autopsy');

   await runAutopsy({ walletLabel, walletAddress, mint });
   ```

Add `autopsy` to CLI help (`-h` / `--help`) with a short description.

---

## 4. Campaign construction

A **campaign** is:
> All trades of a given mint for a given wallet.

### 4.1 Ensure token metadata exists (`coins` table)

1. Query the `coins` table for the mint.
   - Use an existing helper if one exists; otherwise add one in the DB module.
2. If **no row** exists:
   - Call `getTokenInfo(mint)`.
   - Insert that token metadata into `coins`.
3. You should end up with a `tokenInfo` object containing at least:
   - `mint`
   - `symbol`
   - `name`
   - `decimals`
   - Any other useful fields from SolanaTracker

### 4.2 Fetch and filter wallet trades

1. Fetch all trades for the wallet:

   ```js
   const allTrades = await client.getWalletTrades(walletAddress);
   ```

2. Filter to this mint:

   ```js
   const mintTrades = allTrades.filter(t => t.mint === mint);
   ```

3. If `mintTrades.length === 0`:
   - Print a friendly message and exit cleanly (no file writes, no AI call).

### 4.3 Campaign time window

Compute the campaign window:

```js
const startTimestamp = Math.min(...mintTrades.map(t => t.timestamp));
const endTimestamp   = Math.max(...mintTrades.map(t => t.timestamp));
```

You can pad the window later if needed; v1 can be a tight range.

### 4.4 Campaign metrics

From `mintTrades` and/or `getTokenPnL`, compute at least:

- `realizedPnLSol`
- `realizedPnLPercent`
- `avgEntryPrice`
- `avgExitPrice`
- `holdDurationSeconds` (first buy → last sell)
- `maxPriceAfterEntry` (within campaign window)
- `minPriceAfterEntry` (within campaign window)
- `feesPaidSol`
- `feeToPnLRatio`

Store these under `campaign.metrics`. Keep math simple and deterministic.

---

## 5. Market context

Using the Data API client:

1. `priceRange = await client.getPriceRange(mint, startTimestamp, endTimestamp)`
   - Lowest and highest price in the campaign window.

2. `tokenPnL = await client.getTokenPnL(walletAddress, mint, true)`
   - `holdingCheck = true`.
   - Realized PnL and other metrics.

3. `athPrice = await client.getAthPrice(mint)`
   - All‑time high price.

Include these in `marketContext`.

---

## 6. OHLCV candle window

We want the AI to see local price action around the campaign.

1. Define a time window:

   ```js
   const windowStart = startTimestamp - 300; // 5 minutes before
   const windowEnd   = endTimestamp + 300;   // 5 minutes after
   ```

2. Fetch 1‑minute candles for `[windowStart, windowEnd]` using the existing candles endpoint.

3. Add **guardrails**:
   - Avoid sending thousands of candles.
   - Options (implement at least one):
     - Cap the number of candles (e.g., 300–500 max).
     - Downsample (e.g., take every Nth candle).
     - Fall back to a higher timeframe (e.g., 5m) for very long windows.

4. Represent the result as:

   ```js
   const ochlvWindow = {
     granularity: '1m',
     startTimestamp: windowStart,
     endTimestamp: windowEnd,
     candles: [
       // Compact objects like { t, o, h, l, c, v }
     ]
   };
   ```

Add this under `marketContext.ochlvWindow`.

---

## 7. Autopsy payload structure

Build a **single payload object** that serves as both:

- Input to the AI job, and
- The core of the persisted autopsy JSON file.

Suggested shape:

```js
const payload = {
  wallet: {
    label: walletLabel,
    address: walletAddress
  },
  token: {
    mint,
    symbol: tokenInfo.symbol,
    name: tokenInfo.name,
    decimals: tokenInfo.decimals,
    tokenInfo // raw or normalized tokenInfo from SolanaTracker
  },
  campaign: {
    trades: mintTrades,
    startTimestamp,
    endTimestamp,
    metrics: {
      realizedPnLSol,
      realizedPnLPercent,
      avgEntryPrice,
      avgExitPrice,
      holdDurationSeconds,
      maxPriceAfterEntry,
      minPriceAfterEntry,
      feesPaidSol,
      feeToPnLRatio
    }
  },
  marketContext: {
    priceRange,
    tokenPnL,
    athPrice,
    ochlvWindow
  },
  meta: {
    createdAt: new Date().toISOString(),
    scoundrelVersion: <version_if_available>,
    command: 'autopsy'
  }
};
```

Keep keys compact and avoid unnecessary duplication.

---

## 8. AI job: `ai/jobs/tradeAutopsy.js`

Create a new AI job module:

- File: `ai/jobs/tradeAutopsy.js`

### 8.1 Purpose

This job is Warlord’s **trade autopsy engine**.
Given the payload above, it produces a structured post‑mortem that explains:

- Quality of **entries**
- Quality of **exits**
- Risk management
- Realized PnL vs reasonable opportunity
- Concrete lessons and tags for future learning
- A simple grade

Assume the trader is a Solana memecoin degen with basic trading knowledge. Tone should be direct, practical, and slightly degen‑friendly without being cringe.

### 8.2 System instructions (high level)

System prompt (paraphrased, you can adapt wording but keep intent):

> You are Warlord’s trade autopsy engine.
> You receive JSON describing a single “campaign” in one token for one wallet, including all trades, realized PnL, metrics, price range, token PnL, all-time high, and a window of OHLCV candles around the campaign.
>
> Your job is to perform a realistic post-mortem of how the campaign was executed:
> - Judge the quality of entries and exits relative to the price action.
> - Identify what the trader did well.
> - Identify mistakes (e.g., chased pumps, cut winners early, bagheld, oversized).
> - Propose specific, concrete changes that would have improved profitability or reduced risk, without relying on perfect hindsight.
>
> Assume the trader is an active Solana memecoin degen who understands basic trading concepts. Keep your tone direct, practical, and coaching-focused.
>
> Constraints:
> - Use the provided numbers and candles; do not invent prices or timestamps.
> - Respect liquidity and execution realism.
> - Feedback should be coaching, not shaming.

### 8.3 Output schema

Define and enforce a strict JSON output contract, for example:

```json
{
  "grade": "B-",
  "summary": "...",
  "entryAnalysis": "...",
  "exitAnalysis": "...",
  "riskManagement": "...",
  "profitability": "...",
  "lessons": [
    "First lesson...",
    "Second lesson..."
  ],
  "tags": [
    "cut_winner_early",
    "chased_pump",
    "respected_stop"
  ]
}
```

In the prompt, instruct the model:

> Respond **only** with a JSON object matching this schema. Do not include markdown or any additional commentary.

Wire this job into the existing AI client the same way other jobs are wired.

---

## 9. Implementing `lib/autopsy.js`

Create a new module `lib/autopsy.js`:

```js
/**
 * Run a trade autopsy for a single wallet + mint campaign.
 *
 * @param {Object} params
 * @param {string} params.walletLabel   Human-friendly label or "other".
 * @param {string} params.walletAddress Base58 wallet pubkey.
 * @param {string} params.mint          Token mint address.
 * @returns {Promise<void>}
 */
async function runAutopsy({ walletLabel, walletAddress, mint }) {
  // implementation
}

module.exports = { runAutopsy };
```

Inside `runAutopsy`:

1. Instantiate the SolanaTracker Data API client.
2. Ensure token info exists in the `coins` table; fetch or insert via `getTokenInfo`.
3. Fetch wallet trades, filter to the mint, and build campaign metrics.
4. Fetch `priceRange`, `tokenPnL`, `athPrice`, and the OHLCV window.
5. Assemble the full payload object.
6. Call the `tradeAutopsy` AI job with that payload.
7. Persist the resulting autopsy JSON to disk.
8. Print a concise CLI summary using `chalk`.

### 9.1 Autopsy JSON path & structure

Save autopsy outputs under:

- Directory: `./autopsy/<walletLabel>/`
- Filename pattern:

  ```text
  autopsy-<walletLabel>-<mint>-<timestamp>.json
  ```

Example:

```text
./autopsy/warlord/autopsy-warlord-GtL1QDLS6XAbf56KykH35m2QTWGkuebnrQpBcaFNpump-1763231234.json
```

Suggested file content:

```js
{
  wallet: { ... },
  token: { ... },
  campaign: { ... },
  marketContext: { ... },
  aiResult: { ... },
  meta: {
    createdAt: '2025-11-15T12:34:56.789Z',
    scoundrelVersion: 'x.y.z',
    command: 'autopsy'
  }
}
```

### 9.2 CLI summary output

After saving the file, print a short, readable summary, for example:

```text
💀 AUTOPSY COMPLETE: warlord on 2Z (GtL1QDL...)

PnL: +0.42 SOL (+23.5%) over 38 minutes
Grade: B-
Key takeaway: Cut winner early; solid risk control, but left upside on table.

Saved: ./autopsy/warlord/autopsy-warlord-GtL1QDL...-1763231234.json
```

Use `chalk` for emphasis, but keep output compact and non‑spammy.

### 9.3 Error handling

For each major stage (DB, Data API, AI, file IO):

- Wrap with `try/catch`.
- Include contextual info in errors (wallet label, address, mint, stage name).
- Fail gracefully when possible and inform the user.

---

## 10. Tests (Jest)

Add Jest tests for `lib/autopsy.js` and related wiring. Mock external dependencies:

- SolanaTracker Data API client:
  - `getWalletTrades`
  - `getTokenInfo`
  - `getPriceRange`
  - `getTokenPnL`
  - `getAthPrice`
  - Candles endpoint
- DB helpers for `coins`
- `tradeAutopsy` AI job

Verify at least:

- Campaign payload is built correctly for a simple scenario.
- Behavior when the `coins` row exists vs missing (ensure `getTokenInfo` is only called when needed).
- Behavior when there are **no trades** for the mint (graceful exit, no file write).
- Candle window guardrails (caps / downsampling) behave as expected.
- Output file path and naming convention are correct.
- `aiResult` is present in the saved JSON.

You do not need exhaustive payload snapshots; assert key structure and fields.

---

## 11. Documentation

Update or add docs:

- `README.md` — add a short **Autopsy** section:
  - What it does
  - Example CLI usage
- `AGENTS.md` or `docs/autopsy.md` — more detail for agents/humans:
  - CLI workflow
  - JSON output shape
  - How Warlord AI is expected to consume these files later

Keep tone consistent with **VAULT77 / Scoundrel** (fun but clear).

---

## 12. Git commit strategy

Use clear, incremental commit messages, for example:

- `feat(autopsy): add CLI wiring and autopsy orchestrator`
- `feat(autopsy): add tradeAutopsy AI job`
- `test(autopsy): add Jest coverage for runAutopsy`
- `docs(autopsy): document autopsy command and JSON output`

When everything is wired up, I should be able to run:

```bash
scoundrel autopsy
```

- Select a HUD wallet (or choose "Other" and paste a wallet)
- Enter a mint
- Receive:
  - A clean CLI summary (PnL, grade, key takeaway)
  - A JSON file saved under `./autopsy/<walletLabel>/` containing the full payload and AI result.