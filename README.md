# Scoundrel — a VAULT77 🔐77 relic

> *Unearthed from VAULT77, Scoundrel is a relic software tool built for trench operators.  
> It harvests and analyzes the trading patterns of top wallets, relays strategies, and keeps the link open to save our futures.*

## 📡 Connect with VAULT77

- **VAULT77 Community**: [Join on X](https://x.com/i/communities/1962257350309650488)  
- **Telegram (Community)**: [@BurnWalletBroadcast](https://t.me/BurnWalletBroadcast)  
> Join VAULT77 🔐77 and become part of the operator network.

## Project Goals
Scoundrel is part of the VAULT77 🔐77 toolchain — a research and trading side project designed to explore the use of OpenAI’s APIs and SolanaTracker data to improve memecoin trading strategies. The main goals are:

1. **Learn from Top Traders**  
   Analyze the historical on-chain trades of well-known wallets to identify styles, strategies, and patterns that consistently produce profitable results.

2. **Profile Trading Styles**  
   Build compact style profiles (e.g., momentum scalper, liquidity sniper, mean reverter) that can be recognized and applied to new trade opportunities.

3. **COMING SOON!!!! Integrate with Warlord Bot**  
   Use the outputs from the analysis layer as a validator module inside the bot. When the bot signals a buy, Scoundrel provides a second opinion to confirm, size, or veto the trade.

4. **Balance Speed with Explainability**  
   Keep the core signals fast and deterministic, while using OpenAI models for policy validation, risk rules, and human-readable rationale.

---

## Requirements

- A [SolanaTracker.io](https://www.solanatracker.io/?ref=0NGJ5PPN) account (used for wallet and trade history).  
- An [OpenAI](https://openai.com/) account and the knowledge to operate its APIs.  
- A MySQL database
- Node.js 22 LTS and npm.

---

## What’s new (Nov 2025)

Scoundrel has been refactored to a **Responses‑first** architecture. No Assistants, no Chat Completions, no thread state. We send **JSON in** and get **schema‑locked JSON out**.

**Highlights**
- Clean AI backbone: `/ai/client.js` (Responses) + `/ai/jobs/*` + `/ai/schemas/*`.
- Operator dossier with **operator_summary**: CT/CIA‑style reporting and analysis.
- CLI processors called directly (no thin shims):
  - `dossier.js` → harvests wallet trades + chart, merges into unified JSON, and calls AI job.
  - `ask.js` → Q&A over a saved profile.
  - `tune.js` → strategy tuning proposals.
- Deterministic outputs via **JSON Schema (strict)**.
- Quiet, predictable logging (`NODE_ENV=production` by default).
- `dossier -r` flag to re-run AI on latest merged file without re-harvesting.

---

## Architecture

```
SolanaTrackerDataClient ──▶ /lib/dossier.js
                          └─ trades + chart + meta (merged JSON)

/lib/dossier.js ──▶ /ai/jobs/walletAnalysis.js (Responses API)
                     └─ writes to ./profiles/<name>.json + operator_summary markdown

CLI commands ───────────▶ /lib/*.js processors
```

- **Data Source**: SolanaTracker Data API (`getWalletTrades`, `getWalletChart`).
- **AI Jobs**: Small, single‑purpose modules that construct a request (system + user + schema) and call the **Responses API**.
- **Schemas**: Versioned under `/ai/schemas/…` and kept strict (`additionalProperties: false`, explicit `required`).

---

## Solana RPC methods library

Scoundrel now ships a dedicated SolanaTracker RPC façade at `lib/solana/rpcMethods/`. Think of it as the VAULT77 relay tower: it binds the low-level Kit client to a clean, human-scale API.

```js
const { createSolanaTrackerRPCClient } = require('./lib/solanaTrackerRPCClient');
const { createRpcMethods } = require('./lib/solana/rpcMethods');

const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
const rpcMethods = createRpcMethods(rpc, rpcSubs);

const balance = await rpcMethods.getSolBalance('walletPubkey');
```

### HTTP helpers (all return Promises)

| Helper | Signature | Notes |
| --- | --- | --- |
| `getSolBalance` | `(pubkey: string) => Promise<number>` | Converts lamports → SOL.
| `getTokenAccountsByOwner` | `(owner: string, opts?) => Promise<{ owner, accounts, raw }>` | Normalized SPL positions.
| `getTokenAccountsByOwnerV2` | `(owner: string, opts?) => Promise<{ owner, accounts, hasMore, nextCursor, totalCount, raw }>` | Cursor + pagination metadata.
| `getMultipleAccounts` | `(pubkeys: string[], opts?) => Promise<{ accounts, raw }>` | Batched account infos.
| `getFirstAvailableBlock` | `() => Promise<number>` | Earliest slot SolanaTracker serves.
| `getTransaction` | `(signature: string, opts?) => Promise<{ signature, slot, blockTime, transaction, meta, raw } | null>` | Returns `null` when the signature is unknown.

### WebSocket helpers

Every subscription returns `{ subscriptionId, unsubscribe }`, accepts an `onUpdate` callback, and honors SolanaTracker options (plus optional `onError`).

- `subscribeAccount(pubkey, onUpdate, opts?)`
- `subscribeBlock(onUpdate, opts?)`
- `subscribeSlot(onUpdate, opts?)`
- `subscribeSlotsUpdates(onUpdate, opts?)`

The warchest HUD worker (`scripts/warchestHudWorker.js`) now leans on `rpcMethods.getSolBalance`, keeping SOL deltas accurate without poking the raw Kit client.

---

## SolanaTracker Data API library

`lib/solanaTrackerDataClient.js` follows the same pattern: a thin factory binds the official `@solana-tracker/data-api` SDK to a folder of focused helpers under `lib/solanaTrackerData/methods/`. Every helper lives in its own module, carries unit tests under `__tests__/solanaTrackerData/methods/`, and runs through a shared retry/logger wrapper.

```js
const { SolanaTrackerDataClient } = require('./lib/solanaTrackerDataClient');

const data = new SolanaTrackerDataClient({ apiKey: process.env.SOLANATRACKER_API_KEY });
const token = await data.getTokenInformation('Mint...');
const chart = await data.getWalletChart('Wallet...');
const risk  = await data.getTokenRiskScores('Mint...');
```

### High-signal helpers

| Helper | Notes |
| --- | --- |
| `getTokenInformation` / `getTokenByPoolAddress` | direct token lookups. |
| `getTokenHoldersTop100`, `getLatestTokens`, `getMultipleTokens` | supply discovery feeds. |
| `getTrendingTokens`, `getTokensByVolumeWithTimeframe`, `getTokenOverview` | curated discovery endpoints. |
| `getTokenPrice`, `getMultipleTokenPrices` | wrap `/price` + `/price/multi` with retries. |
| `getWalletTokens`, `getBasicWalletInformation` | wallet state snapshots. |
| `getWalletTrades` | paginated harvest with optional `startTime` / `endTime` filtering and cursor handling. |
| `getWalletChart` | portfolio curve, aliased as `getWalletPortfolioChart` for CLI consistency. |
| `getTokenOhlcvData`, `getTokenPoolOhlcvData` | Chart/OHLCV endpoints for tokens or token/pool pairs. |
| `getWalletPnl` | full-wallet pnl, optional `showHistoricPnl`, `holdingCheck`, `hideDetails`. |
| `getTopTradersForToken` | top 100 profitable traders for a mint. |
| `getTokenEvents` | decodes binary event streams into JSON. |
| `getTokenRiskScores` | wraps `/risk/:mint`, normalizes `score`, `rating`, and per-factor severities (see docs/risk section). |
| `searchTokens` | flexible search builder; arrays become comma lists, objects auto-JSON encode. |
| `getTokenSnapshotAt`, `getTokenSnapshotNow` | composite helpers combining price + metadata. |
| `healthCheck` | lightweight readiness probe used by dossier + CLI smoke tests. |

All helpers share the same error contract: retries on `RateLimitError`, 5xx, or transient network faults, and they rethrow enriched `DataApiError` instances so callers can branch on `.status` / `.code`.

Special endpoints:
- **Risk** (`getTokenRiskScores`) returns `{ token, score, rating, factors, raw }`. Each factor carries `{ name, score, severity }` so downstream risk caps can stay deterministic.
- **Search** (`searchTokens`) accepts advanced filters (arrays, nested objects) and translates them into the query-string the API expects. Empty filters throw immediately so we never spam the API with no-ops.

See the per-file JSDoc in `lib/solanaTrackerData/methods/*.js`, the matching tests under `__tests__/solanaTrackerData/methods/*.test.js`, and `docs/solanaTrackerData.md` for signature details plus risk/search notes.

---

## Commands

> Run `node index.js --help` or append `--help` to any command for flags & examples.

### `dossier <WALLET>`
Harvests wallet trades + chart, merges a unified JSON payload, and sends it to the OpenAI Responses API to generate a CT/CIA‑style operator report.

- Writes `./profiles/<alias>.json`
- Writes merged file to `./data/<alias>-merged-*.json`
- Prints the report to the console
- Use `-r` / `--resend` to re-run AI on the latest merged file without re-harvesting

Flags:
- `-n, --name`       Human trader name (spaces allowed)
- `-r, --resend`     Reuse latest merged file for given -n alias
- `-l, --limit`      Max trades to fetch (default HARVEST_LIMIT)

### `ask`  
Ask a question about a trader using their saved profile (Responses API).

- Reads `./profiles/<name>.json` for context.
- Returns a concise answer; may include bullets and suggested actions.

Examples:
```bash
node index.js ask -n Gh0stee -q "What patterns do you see?"
node index.js ask -n Gh0stee -q "List common entry mistakes."
```

### `tune`  
Get safe, incremental tuning recommendations for your strategy settings.

- Uses the saved profile plus your current settings (env‑backed defaults).
- May emit a partial JSON `changes` object and/or a JSON Patch array.

Example:
```bash
node index.js tune -n Gh0stee
```

### `test`
Quick self‑check: environment and presence of core files.

```bash
node index.js test
```

---

## Data artifacts

- `./profiles/<alias>.json` — final dossier with markdown + operator_summary
- `./data/<alias>-merged-*.json` — full merged payload (used for resend mode)

---

## Schemas & determinism

All AI jobs enforce **strict JSON Schema**. The wallet profile currently includes (non‑exhaustive):
- `summary`: string
- `behavior`: `{ style, avgHoldMins, winRate, notes }`
- `top_mints`: array (≥ 3 items) with `{ mint, symbol, trades, estPnLUsd }`
- `risks`: array of strings
- `timeline`: array (≥ 3 items) of key moments
- `equity_curve`: `{ startValueUsd, endValueUsd, totalReturnPct, maxDrawdownPct }`
- `trade_stats`: `{ total, buys, sells }`

> If you change fields, update the corresponding schema under `/ai/schemas/` so the model output stays deterministic.

---

## Logging & ops

- **Production** (`NODE_ENV=production`): minimal logs; writes only final artifacts.
- **Development**: includes sizes, sample write paths, and model output snippets.
- Failures are explicit (missing env, schema violations, or upstream API errors).

---

## Roadmap

- **More jobs**: transaction analysis, copy‑trader monitors, codex strategy diffs.
- **Events** (later): first‑class tasks on wallet activity → run jobs.
- **Richer profiles**: narrative/sector flags, fee tolerance bands, time‑of‑day patterns.
- **Tight bot loop**: feed verdicts into Beware/Warlord, shadow mode → guarded live.

---

## 📡 Connect with VAULT77

- **VAULT77 Community**: [Join on X](https://x.com/i/communities/1962257350309650488)  
- **Telegram (Community)**: [@BurnWalletBroadcast](https://t.me/BurnWalletBroadcast)  
> Join VAULT77 🔐77 and become part of the operator network.

---


## Roadmap to Success

### Phase 1 — Data Harvesting (Currently here)
- Select a set of famous wallets to track.
- Pull their trade history from SolanaTracker.
- For each trade, snapshot the token’s history at the time of entry and exit.
- Store enriched data locally (features, outcomes, fees, realized PnL).

### Phase 2 — Feature Engineering & Labeling
- Engineer features at trade time: price, liquidity, spread, velocity, holders, pool age, creator flags, etc.
- Label outcomes at multiple horizons (5m, 15m, 1h, 24h).
- Normalize for all fees to ensure net PnL realism.

### Phase 3 — Style Profiling
- Cluster wallet histories into trading styles.
- Extract descriptors (entry timing, hold duration, fee tolerance).
- Encode as JSON “playbooks” that can be referenced later.

### Phase 4 — LLM Integration
- Build an OpenAI-powered validator that:
  - Compares live signals to learned profiles.
  - Runs rulebook checks (liquidity floors, dust guards, rug heuristics).
  - Produces structured JSON verdicts (proceed, reduce size, veto).
  - Logs rationale for journaling and social content.

### Phase 5 — Bot Integration
- Connect validator into the Warlord Bot event bus.
- Run numeric signals first, then validate with Scoundrel.
- Enforce risk caps locally regardless of model output.
- Operate in shadow mode before live trading.

### Phase 6 — Production & Iteration
- Go live with small caps and strict trailing stops.
- Evaluate results weekly against fees and benchmarks.
- Retrain style profiles as wallets evolve.
- Expand coverage to new traders and coins.

---

## Success Criteria
- **Consistency**: Validator adds measurable edge to raw indicator signals.
- **Resilience**: Trades respect liquidity/fee constraints and avoid dust traps.
- **Explainability**: Every trade comes with machine-readable verdict and short rationale.
- **Scalability**: Easy to add new wallets, styles, and rules over time.

---

# Scoundrel — a VAULT77 🔐77 relic

> *Unearthed from VAULT77, Scoundrel is a trench-ops toolkit. It harvests and analyzes top wallets, distills trading playbooks, and feeds them to our bots so we can live to fight another day.*
