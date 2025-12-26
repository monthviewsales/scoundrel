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
- SQLite accessible to Node (BootyBox stores data in `db/bootybox.db`, override via `BOOTYBOX_SQLITE_PATH`).

## Testing

- Run the full suite with `npm test`.
- For CI-grade runs with coverage output to `artifacts/coverage/`, use `npm run test:ci` (also used by GitHub Actions).
- Dossier now includes its own dedicated unit test at `__tests__/dossier.test.js`, which validates merged payload construction, user-token-trade harvesting, and technique feature assembly.

## Database Access (BootyBox)

BootyBox now lives natively under `/db` (no git submodule) and exports the full helper surface (coins, positions, sc_* tables, warchest registry). Import it directly via `require('../db')` from application modules and tests.

- `init()` must run before calling other helpers; it initializes the SQLite adapter and schema.
- Wallet registry helpers (`listWarchestWallets`, `insertWarchestWallet`, etc.) power the CLI (`lib/cli/warchestCli.js`) and are wrapped under `lib/wallets/walletRegistry.js`.
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


The warchest HUD worker (`lib/warchest/workers/warchestService.js`) now leans on `rpcMethods.getSolBalance`, keeping SOL deltas accurate without poking the raw Kit client.
- The HUD also calls `getMultipleTokenPrices` from the SolanaTracker Data API to fetch live USD prices for SOL and all held tokens.
- Session lifecycle is persisted via `sc_sessions`: the worker closes any stale session it finds (using the last snapshot in `data/warchest/status.json`) before opening a new one, heartbeats the active session via its health loop, and records the session metadata inside `health.session` for CLI status commands.
- Clean shutdowns (`SIGINT`, CLI stop) now finalize the open session with the most recent slot/block time; unexpected exits are recorded as `end_reason='crash'` on the next launch.
- The worker runs a WS heartbeat watchdog: if `slotSubscribe` goes stale, it restarts the SolanaTracker Kit RPC client + resubscribes, and surfaces restarts/errors in the HUD + `data/warchest/status.json`.
  - `WARCHEST_WS_STALE_MS` (default `20000`) – restart when no slot update for this long.
  - `WARCHEST_WS_RESTART_GAP_MS` (default `30000`) – minimum time between restarts.
  - `WARCHEST_WS_RESTART_MAX_BACKOFF_MS` (default `300000`) – cap exponential backoff after failed restarts.
  - `WARCHEST_WS_UNSUB_TIMEOUT_MS` (default `2500`) – timeout for unsubscribe/close during restarts.
- HUD shows a live “Recent Transactions” feed (default 10) sourced from `data/warchest/tx-events.json`, with status emoji (🟢 confirmed, 🔴 failed, 🟡 processed), side, mint/name, price + 1m/5m/15m/30m deltas when tokenInfo is available. Recent per-wallet logs remain but are capped (default 5).
  - `WARCHEST_HUD_MAX_TX` (default `10`) – max transactions displayed.
  - `WARCHEST_HUD_MAX_LOGS` (default `5`) – max recent logs per wallet.
- Each RPC client tracks its live WebSocket handles; `service.sockets` in health snapshots shows the active count so leaked sockets can be spotted and terminated on restart.

### Reading `data/warchest/status.json`

- Location: `./data/warchest/status.json` is refreshed every ~5s (daemon or HUD).
- Key fields:
  - `process.rssBytes` / `loadAvg1m` – memory and host pressure; sustained climbs suggest leaks or stuck jobs.
  - `ws.lastSlotAgeMs` – WS freshness; values > `WARCHEST_WS_STALE_MS` should trigger a restart. Healthy is single-digit ms–seconds.
  - `service.wsSupervisor` – restart history (`restarts`, `lastRestartAt`, `lastRestartReason`, `backoffMs`, `restartInFlight`). Frequent restarts with nonzero `backoffMs` mean the endpoint is flapping.
  - `service.sockets` – current WS handles owned by the RPC client. Normal is 1–3. Growth over time indicates a cleanup problem; restarting the worker should reset to 1–3.
  - `session.*` – current BootyBox session metadata (id, start slot/time, last heartbeat).
- Quick triage:
  - If `lastSlotAgeMs` climbs and `restarts` stays flat, WS may be wedged; manually restart the worker.
  - If `sockets` climbs above 3, restart the worker; the registry is cleaned on restart.
  - If `loadAvg1m` spikes alongside `restarts`, check network/endpoint health; backoff will slow restarts.

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
- `getWalletForSwap.js` – builds a swap-ready runtime wallet (signer + pubkey verification) from registry rows.

BootyBox remains the source of truth for persisted wallets. Keep key material protected when adding swap/signing support.

Special endpoints:
- **Risk** (`getTokenRiskScores`) returns `{ token, score, rating, factors, raw }`. Each factor carries `{ name, score, severity }` so downstream risk caps can stay deterministic.
- **Search** (`searchTokens`) accepts advanced filters (arrays, nested objects) and translates them into the query-string the API expects. Empty filters throw immediately so we never spam the API with no-ops.

See the per-file JSDoc in `lib/solanaTrackerData/methods/*.js`, the matching tests under `__tests__/solanaTrackerData/methods/*.test.js`, and `docs/solanaTrackerData.md` for signature details plus risk/search notes.

---

## Commands

> Run `node index.js --help` or append `--help` to any command for flags & examples.

-**Quick reference**
  
- `research <walletId>` — (deprecated) Alias for `dossier --harvest-only`; harvests wallet trades + chart + per-mint user trades without calling AI.
- `dossier <walletId>` — Harvest pipeline with richer flags (`--limit`, `--feature-mint-count`, `--resend`, `--harvest-only`).
- `autopsy` — Interactive wallet+mint campaign review; builds enriched payload and runs the `tradeAutopsy` AI job.
- `tx <signature>` — Inspect transaction status, fees, and (optional) swap deltas for a focus wallet/mint.
- `swap <mint>` — Execute a swap through the SolanaTracker swap API (also manages swap config via `-c`).
- `ask` — Q&A against a saved dossier profile (plus optional enriched rows).
- `addcoin <mint>` — Fetch and persist token metadata via SolanaTracker Data API.
- `warchest [subcommand]` — Manage local wallet registry (add/list/remove/set-color/solo picker).
- `warchestd <action>` — Launch the HUD follower in the foreground, clean legacy daemon artifacts, or show hub status.
- `test` — Environment + dependency smoke test.

## Architecture

- Worker harness + hub live under `lib/warchest/workers/` and `lib/warchest/hubCoordinator.js`, coordinating swap/monitor/HUD jobs via IPC.
- Hub status + HUD events are written to `data/warchest/status.json` and `data/warchest/tx-events.json`; the HUD follows these files instead of daemon PID files.
- See `docs/warchest_process_notes.md` and `docs/warchest_worker_phased_plan.md` for orchestration details and phased goals.

### research `<walletId>`
- (Deprecated) Thin wrapper around the dossier pipeline; equivalent to running `dossier <walletId> --harvest-only`.
- Harvests trades + wallet chart + latest mints (skips SOL/stables), builds technique features, and writes merged/enriched artifacts when `SAVE_*` toggles are set.
- Does **not** call OpenAI, write profile JSON under `profiles/<alias>.json`, or upsert wallet analyses; use `dossier` without `--harvest-only` for full AI profiles.
- Options: `--start <iso|epoch>`, `--end <iso|epoch>`, `--name <alias>`, `--feature-mint-count <num>`.
- Env: `SOLANATRACKER_API_KEY`, optional `FEATURE_MINT_COUNT`, `HARVEST_LIMIT`.

### dossier `<walletId>`
- Core harvest pipeline for building wallet dossiers; drives both full AI profiles and harvest-only runs.
  - `--limit <num>` cap trades
  - `--feature-mint-count <num>` override mint sampling
  - `--resend` re-run AI on latest merged payload without new data pulls
  - `--harvest-only` harvests trades + chart + per-mint trades and writes artifacts but skips the OpenAI dossier call and DB upsert.
- Default: writes merged/enriched artifacts (when `SAVE_*` toggles are set), saves dossier JSON to `profiles/<alias>.json`, and persists an `sc_profiles` snapshot.
- With `--harvest-only`: writes only the harvest artifacts (no dossier JSON, no profile DB upsert).

### autopsy
- Prompts for HUD wallet (or custom address) + mint, then builds a campaign payload:
  - user token trades, token metadata, price range, PnL, ATH, OHLCV window, derived metrics
- Runs `tradeAutopsy` AI job, prints graded analysis, and saves `profiles/autopsy-<wallet>-<mint>-<ts>.json`.
- Raw/parsed/enriched artifacts land under `data/autopsy/<wallet>/<mint>/` when enabled.

### tx `<signature>` [--sig ...] [--swap --wallet <alias|address> --mint <mint>]
- Fetches transaction(s) via `rpcMethods.getTransaction`.
- Prints status, slot/block time, network fee, and per-account SOL deltas.
- Swap mode adds wallet/mint deltas, decodes errors, and upserts fee-only or swap events to `sc_trades` when the wallet is tracked.

### swap `<mint>` (plus config mode)
- Swap execution: requires `--wallet <alias|address>` plus exactly one of `--buy <SOL|%>` or `--sell <amount|%|auto>`.
- Options: `--dry-run`, `--detach` (return after submit; txMonitor persists in background).
- Internals: `lib/cli/swap.js` → `lib/warchest/workers/swapWorker.js` → `lib/warchest/workers/txMonitorWorker.js` (Ink progress UI when TTY).
- Config mode: `scoundrel swap --config` (Ink-based editor; file location and keys unchanged from previous swap config docs).
- Outputs txid/solscan link, token/SOL deltas, fees, price impact, and raw quote when enabled.

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
- HUD follower controller around `lib/warchest/workers/warchestService.js` (foreground only).
- `start/restart` optionally accept `--wallet alias:pubkey:color` (repeatable) and `--hud` to render the HUD alongside hub status/events.
- `hud` runs foreground HUD (with selector fallback); `status` reads hub status snapshot and reports health (slot, RPC timings, wallet count).

### test
- Verifies `OPENAI_API_KEY` presence, prints core file existence, DB config, and attempts BootyBox ping.
- Exits non-zero when API key is missing.

---

## Data artifacts

- `./profiles/<alias>.json` — final dossier with markdown + operator_summary
- `./profiles/autopsy-<wallet>-<mint>-<ts>.json` — trade autopsy payload + AI output
- `./data/dossier/<alias>/merged/merged-*.json` — full merged payload (used for resend mode)
- `./data/autopsy/<wallet>/<mint>/{raw,parsed,enriched}/` — campaign artifacts gated by `SAVE_*`
- `./data/warchest/{tx-events.json,status.json}` — Hub/HUD event feed + health snapshot

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

- **Production** (`NODE_ENV=production`): defaults to `LOG_LEVEL=info` (override via `LOG_LEVEL`); keeps JSON artifacts + rotating log files as configured.
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
