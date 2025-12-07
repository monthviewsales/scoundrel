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
- Node.js 22 LTS and npm.
- SQLite accessible to Node (BootyBox defaults to `db/bootybox.db`, override via `BOOTYBOX_SQLITE_PATH`).

## Testing

- Run the full suite with `npm test`.
- For CI-grade runs with coverage output to `artifacts/coverage/`, use `npm run test:ci` (also used by GitHub Actions).
- Dossier now includes its own dedicated unit test at `__tests__/dossier.test.js`, which validates merged payload construction, user-token-trade harvesting, and technique feature assembly.

## Database Access (BootyBox)

BootyBox now lives natively under `/db` (no git submodule) and exports the full helper surface (coins, positions, sc_* tables, warchest registry). Import it directly via `require('../db')` from application modules and tests.

- `init()` must run before calling other helpers; it initializes the SQLite adapter and schema.
- Wallet registry helpers (`listWarchestWallets`, `insertWarchestWallet`, etc.) power the CLI (`commands/warchest.js`) and are wrapped under `lib/wallets/registry.js`.
- Persistence helpers wrap every Scoundrel table: `recordAsk`, `recordTune`, `recordJobRun`, `recordWalletAnalysis`, `upsertProfileSnapshot`, and `persistWalletProfileArtifacts`.
- Loader coverage includes `db/test/*.test.js`, which run alongside the rest of Jest.

If you add a new persistence path, implement it inside BootyBox so the helper surface stays centralized.

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
| `getTransaction` | `(signatureOrSignatures: string \| string[], opts?) => Promise<tx \| tx[] \| null>` | Accepts a single signature or an array. Returns `null` (or `null` entries in the array) when a signature is unknown. Each tx includes `{ signature, slot, blockTime, transaction, meta, err, status, raw }`. |

### WebSocket helpers

Every subscription returns `{ subscriptionId, unsubscribe }`, accepts an `onUpdate` callback, and (where supported by SolanaTracker) honors options plus an optional `onError` handler. Note that `slotSubscribe` on the current SolanaTracker RPC endpoint does **not** accept any parameters.

- `subscribeAccount(pubkey, onUpdate, opts?)`
- `subscribeBlock(onUpdate, opts?)`
- `subscribeSlot(onUpdate, opts?)`
- `subscribeSlotsUpdates(onUpdate, opts?)`
- `subscribeLogs(filter, onUpdate, opts?)`

WebSocket calls honor `HTTPS_PROXY` / `HTTP_PROXY` env vars (plus `NO_PROXY`) so subscription traffic can traverse locked-down networks.
Use `scripts/testRpcSubs.js` to verify both HTTP + WS access with your SolanaTracker credentials.

#### WebSocket notes (SolanaTracker)

Scoundrel’s RPC client is tuned specifically for SolanaTracker’s mainnet RPC cluster.

- **Connection pattern**
  - Always build the client and helper surface via:
    ```js
    const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
    const rpcMethods = createRpcMethods(rpc, rpcSubs);
    ```
- **Supported WS flows today**
  - `subscribeSlot` – live slot heartbeat; no parameters are allowed on this endpoint.
  - `subscribeAccount` – per-account updates (ideal for wallet SOL/token balances).
  - `subscribeLogs` – program / wallet logs for higher-level activity.
- **Not supported on this endpoint**
  - `blockSubscribe` currently returns a JSON-RPC `Method not found` error on SolanaTracker’s mainnet RPC and should be treated as unavailable.
- **Testing your setup**
  - Use `npm run test:ws` (runs `scripts/testRpcSubs.js`) to verify that your HTTP + WebSocket credentials, proxy settings, and network allow `slotSubscribe` to receive events.

For daemon/HUD work, prefer `subscribeSlot` for chain heartbeat and `subscribeAccount`/`subscribeLogs` for wallet and token activity, and fall back to HTTP polling (`getBlockHeight`, `getSolBalance`, etc.) where WebSocket methods are not available.


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

## Wallet domain

Wallet-related helpers now live under `lib/wallets/`:

- `registry.js` – thin wrapper over the BootyBox-backed warchest registry (no behavior changes).
- `resolver.js` – resolves aliases or pubkeys to registry records or watch-only passthroughs.
- `state.js` – shared live SOL/token state wrapper.
- `scanner.js` – passthrough to the raw RPC wallet scanner.
- `getWalletForSwap.js` – **TODO placeholder** until swap flow is finalized; implement with secure key handling (no plaintext keys/logging).

BootyBox remains the source of truth for persisted wallets. Keep key material protected when adding swap/signing support.

Special endpoints:
- **Risk** (`getTokenRiskScores`) returns `{ token, score, rating, factors, raw }`. Each factor carries `{ name, score, severity }` so downstream risk caps can stay deterministic.
- **Search** (`searchTokens`) accepts advanced filters (arrays, nested objects) and translates them into the query-string the API expects. Empty filters throw immediately so we never spam the API with no-ops.

See the per-file JSDoc in `lib/solanaTrackerData/methods/*.js`, the matching tests under `__tests__/solanaTrackerData/methods/*.test.js`, and `docs/solanaTrackerData.md` for signature details plus risk/search notes.

---

## Commands

> Run `node index.js --help` or append `--help` to any command for flags & examples.

**Quick reference**

- `research <walletId>` — Harvest wallet trades + chart + per-mint user trades; writes merged payload and profile (Responses).
- `dossier <walletId>` — Same harvest pipeline with richer flags (`--limit`, `--feature-mint-count`, `--resend`).
- `autopsy` — Interactive wallet+mint campaign review; builds enriched payload and runs the `tradeAutopsy` AI job.
- `tx <signature>` — Inspect transaction status, fees, and (optional) swap deltas for a focus wallet/mint.
- `swap:config <view|edit|set>` — Manage swap config file (RPC URL, swap API key, slippage, priority fee, tx version).
- `trade <mint>` — Execute a swap through the SolanaTracker swap API using the configured warchest wallet.
- `ask` — Q&A against a saved dossier profile (plus optional enriched rows).
- `addcoin <mint>` — Fetch and persist token metadata via SolanaTracker Data API.
- `warchest [subcommand]` — Manage local wallet registry (add/list/remove/set-color/solo picker).
- `warchestd <action>` — Start/stop/restart the warchest HUD daemon, run HUD foreground, or show status.
- `test` — Environment + dependency smoke test.

### research `<walletId>`
- Harvests trades + wallet chart + latest mints (skips SOL/stables), builds technique features, then runs `analyzeWallet` (Responses).
- Options: `--start <iso|epoch>`, `--end <iso|epoch>`, `--name <alias>`, `--feature-mint-count <num>`.
- Artifacts: merged payload under `data/dossier/<alias>/merged/merged-*.json`; profile JSON under `profiles/<alias>.json`; DB upsert via BootyBox.
- Env: `SOLANATRACKER_API_KEY`, `OPENAI_API_KEY`, optional `FEATURE_MINT_COUNT`, `HARVEST_LIMIT`.

### dossier `<walletId>`
- Same harvest pipeline as `research` plus:
  - `--limit <num>` cap trades
  - `--feature-mint-count <num>` override mint sampling
  - `--resend` re-run AI on latest merged payload without new data pulls
- Writes merged/enriched artifacts (when `SAVE_*` toggles are set), saves dossier JSON to `profiles/<alias>.json`, persists `sc_profiles` snapshot.

### autopsy
- Prompts for HUD wallet (or custom address) + mint, then builds a campaign payload:
  - user token trades, token metadata, price range, PnL, ATH, OHLCV window, derived metrics
- Runs `tradeAutopsy` AI job, prints graded analysis, and saves `profiles/autopsy-<wallet>-<mint>-<ts>.json`.
- Raw/parsed/enriched artifacts land under `data/autopsy/<wallet>/<mint>/` when enabled.

### tx `<signature>` [--sig ...] [--swap --wallet <alias|address> --mint <mint>]
- Fetches transaction(s) via `rpcMethods.getTransaction`.
- Prints status, slot/block time, network fee, and per-account SOL deltas.
- Swap mode adds wallet/mint deltas, decodes errors, and upserts fee-only or swap events to `sc_trades` when the wallet is tracked.

### swap:config `view|edit|set`
- Config file: macOS `~/Library/Application Support/com.VAULT77.scoundrel/swapConfig.json`; other OS: `$XDG_CONFIG_HOME/com.VAULT77.scoundrel/swapConfig.json`.
- Keys: `rpcUrl`, `swapAPIKey`, `slippage`, `priorityFee`, `priorityFeeLevel`, `txVersion`, `showQuoteDetails`, `DEBUG_MODE`.
- `set <key> <value>` casts numbers when possible; `edit` opens `$EDITOR`.

### trade `<mint>`
- Executes a buy/sell via SolanaTracker swap API through `lib/trades` (swapEngine).
- Required: `--wallet <alias|address>` plus exactly one of `--buy <SOL|%>` or `--sell <amount|%|auto>`.
- Optional: `--slippage <pct>` (default 15), `--priority-fee <microlamports|auto>`, `--jito`, `--dry-run`.
- Outputs txid/solscan link, token/SOL deltas, fees, price impact, and raw quote when available.

### ask
- Q&A over `profiles/<name>.json`; includes latest `data/dossier/<alias>/enriched/techniqueFeatures-*` when present.
- Flags: `--name <alias>` (defaults to `default`), `--question <text>` (required).
- Persists ask/answer to DB (BootyBox recordAsk).

### addcoin `<mint>`
- Validates Base58 mint, fetches metadata via SolanaTracker Data API, and caches to DB through `tokenInfoService.ensureTokenInfo`.
- `--force` skips cache; when `SAVE_RAW` is on, writes token info to `data/addcoin/<mint>-<runId>.json`.

### warchest `[add|list|remove|set-color]` [args]
- Wallet registry backed by BootyBox. `--solo` opens a picker for quick lookups.
- `add` prompts for pubkey + signing/watch flag + alias; `set-color` enforces a small palette.

### warchestd `<start|stop|restart|hud|status>`
- Daemon/HUD controller around `scripts/warchestHudWorker.js`.
- `start/restart` optionally accept `--wallet alias:pubkey:color` (repeatable) and `--hud` to run interactive HUD.
- `hud` runs foreground HUD; `status` reads pid/status snapshot and reports health (slot, RPC timings, wallet count).

### test
- Verifies `OPENAI_API_KEY` presence, prints core file existence, DB config, and attempts BootyBox ping.
- Exits non-zero when API key is missing.

---

## Data artifacts

- `./profiles/<alias>.json` — final dossier with markdown + operator_summary
- `./profiles/autopsy-<wallet>-<mint>-<ts>.json` — trade autopsy payload + AI output
- `./data/dossier/<alias>/merged/merged-*.json` — full merged payload (used for resend mode)
- `./data/autopsy/<wallet>/<mint>/{raw,parsed,enriched}/` — campaign artifacts gated by `SAVE_*`
- `./data/warchest/{warchest.pid,status.json}` — HUD daemon pid + health snapshot

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


# Scoundrel — a VAULT77 🔐77 relic

> *Unearthed from VAULT77, Scoundrel is a trench-ops toolkit. It harvests and analyzes top wallets, distills trading playbooks, and feeds them to our bots so we can live to fight another day.*
