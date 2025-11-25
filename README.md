# Scoundrel — a VAULT77 🔐77 relic

> *Unearthed from VAULT77, Scoundrel is a relic software tool built for trench operators.  
> It harvests and analyzes the trading patterns of top wallets, relays strategies, and keeps the link open to save our futures.*

Docs: For a high-level repo overview (LLM-friendly), see `docs/scoundrel-overview.md`.

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

## Testing

- Run the full suite with `npm test`.
- Dossier now includes its own dedicated unit test at `__tests__/dossier.test.js`, which validates merged payload construction, user-token-trade harvesting, and technique feature assembly.

## Database Access (BootyBox)

BootyBox lives in the `packages/bootybox` git submodule and exports the full helper surface (coins, positions, sc_* tables, warchest registry) from whichever adapter matches `DB_ENGINE` (`mysql` or `sqlite`, defaulting to sqlite). Import it directly via `require('../packages/bootybox')` from application modules and tests.

- `init()` must run before calling other helpers; it initializes the chosen adapter and schema.
- Wallet registry helpers (`listWarchestWallets`, `insertWarchestWallet`, etc.) power the CLI (`commands/warchest.js`) and `lib/warchest/walletRegistry.js`.
- Persistence helpers wrap every Scoundrel table: `recordAsk`, `recordTune`, `recordJobRun`, `recordWalletAnalysis`, `upsertProfileSnapshot`, and `persistWalletProfileArtifacts`.
- Loader coverage lives in `__tests__/lib/db/BootyBox.*.test.js`.

If you add a new persistence path, implement it inside BootyBox so the helper surface stays centralized.

- Token metadata caching now flows through `/lib/services/tokenInfoService.js`, which safely merges SolanaTracker metadata with cached DB rows without overwriting good data during API outages.

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
- Full migration from legacy REST `userTokenTradesByWallet` to the official SolanaTracker Data API SDK (`getUserTokenTrades`), including dossier + autopsy.
- Quiet, predictable logging (`NODE_ENV=production` by default).
- `dossier -r` flag to re-run AI on latest merged file without re-harvesting.
- Token metadata caching now flows through `/lib/services/tokenInfoService.js`, which safely merges SolanaTracker metadata with cached DB rows without overwriting good data during API outages.

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
- The HUD also calls `getMultipleTokenPrices` from the SolanaTracker Data API to fetch live USD prices for SOL and all held tokens.

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

These price endpoints are now used by the HUD worker to display live USD estimates for SOL and each token in the warchest.
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
| `getUserTokenTrades` | wallet + mint–specific trades, replaces legacy REST integration. |

All helpers share the same error contract: retries on `RateLimitError`, 5xx, or transient network faults, and they rethrow enriched `DataApiError` instances so callers can branch on `.status` / `.code`.

Token metadata caching is now handled by `/lib/services/tokenInfoService.js`, ensuring dossier, autopsy, and future processors all use a unified, hardened metadata pipeline.

Special endpoints:
- **Risk** (`getTokenRiskScores`) returns `{ token, score, rating, factors, raw }`. Each factor carries `{ name, score, severity }` so downstream risk caps can stay deterministic.
- **Search** (`searchTokens`) accepts advanced filters (arrays, nested objects) and translates them into the query-string the API expects. Empty filters throw immediately so we never spam the API with no-ops.

See the per-file JSDoc in `lib/solanaTrackerData/methods/*.js`, the matching tests under `__tests__/solanaTrackerData/methods/*.test.js`, and `docs/solanaTrackerData.md` for signature details plus risk/search notes.

---

## Commands

> Run `node index.js --help` or append `--help` to any command for flags & examples.

**Warchest HUD (scripts/warchestHudWorker.js)**  
A real-time wallet monitor that displays SOL balance, session deltas, token balances, and live USD prices using SolanaTracker RPC + Data APIs.  
Useful during active trading sessions.

### `dossier <WALLET>`

**Operator Dossier**  
Scoundrel harvests all trades, chart history, and on‑chain features for the selected wallet and generates a full CT/CIA‑style behavioral profile using the Responses API.  

Harvests wallet trades + chart, merges a unified JSON payload, and sends it to the OpenAI Responses API to generate a CT/CIA‑style operator report.

### `autopsy`
Interactive post‑trade analysis. Prompts you to select a tracked HUD wallet (or enter any Solana address) and a token mint, then builds a **single‑campaign trade autopsy** using enriched SolanaTracker data.

The autopsy engine pulls:
- user‑specific token trades  
- token metadata + price range  
- OHLCV window (5m before → last sell → 5m after)  
- PnL (realized + residual)  
- ATH context  

And generates:
- structured JSON coaching analysis (`tradeAutopsy` job)  
- entry/exit evaluation  
- risk assessment and sizing feedback  
- rules + corrections for future trades  

Outputs:
- Writes JSON to: `./profiles/autopsy-<wallet>-<symbol>-<timestamp>.json`
- Saves raw/parsed/enriched artifacts under `./data/autopsy/<wallet>/<mint>/` when `SAVE_RAW`, `SAVE_PARSED`, or `SAVE_ENRICHED` are true
- Prints AI JSON into the terminal in a clean, sectioned layout

### `ask`  
Ask a question about a trader using their saved profile (Responses API).

- Reads `./profiles/<name>.json` for context.
- Returns a concise answer; may include bullets and suggested actions.
- When dossier enrichment is saved, pulls the latest snapshot from `./data/dossier/<alias>/enriched/` for extra context.

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
- `./data/dossier/<alias>/merged/merged-*.json` — full merged payload (used for resend mode)

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

## Maintenance Notes

- The legacy HTTP integration under `integrations/solanatracker/userTokenTrades.js` is now fully deprecated.
  All callers use the official SDK `getUserTokenTrades` method.  
  The file remains only for historical reference and may be removed in a future development cycle.

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
