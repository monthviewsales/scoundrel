# Swap Workflow (Current Implementation)

This document describes the current end-to-end swap workflow so you can plan a refactor to a new swap API. It is based on the CLI → hub → swapWorker → swapV3 pipeline.

## High-level flow

1. CLI validates input, resolves wallet alias, and builds a swap payload.
2. Hub coordinator spawns `swapWorker` with the payload over IPC.
3. `swapWorker` validates payload, resolves the wallet secret, and loads swap config.
4. `swapWorker` calls `swapV3.executeSwapV3()` to:
   - build a transaction via SolanaTracker Swap API
   - sign it locally
   - optionally preflight
   - send it via SolanaTracker RPC
5. `swapWorker` returns a result plus a `monitorPayload`.
6. CLI (via hub) runs `txMonitor` to confirm/persist the swap.

## Workflow diagram (current)

```
CLI (swap.js)
  |
  | payload: { side, mint, amount, walletAlias, ... }
  v
Hub Coordinator
  |
  | IPC: runSwap(payload)
  v
swapWorker
  |-- validate payload
  |-- resolve wallet secret
  |-- load swap config
  |
  |  swapV3.executeSwapV3()
  |    |-- HTTP GET swap builder (SolanaTracker Swap API)
  |    |-- sign locally (Solana Kit)
  |    |-- optional simulate (RPC)
  |    |-- send tx (RPC)
  |
  v
swapWorker result + monitorPayload
  |
  | IPC: runTxMonitor(monitorPayload)
  v
txMonitorWorker
  |-- confirm tx (RPC WS/HTTP)
  |-- persist (BootyBox)
  |-- HUD events/logging
  v
CLI summary + HUD updates
```

## Step-by-step details

## API + RPC calls by module (in order)

### `lib/cli/swap.js` (CLI)
- No external API/RPC calls. Builds payload and invokes hub.

### `lib/warchest/hubCoordinator.js` (hub)
- No external API/RPC calls. Spawns workers and passes payloads via IPC.

### `lib/warchest/workers/swapWorker.js` (swap worker)
- SolanaTracker RPC HTTP:
  - Creates client via `createSolanaTrackerRPCClient()`.
  - Uses `rpc.sendTransaction(...)` and optionally `rpc.simulateTransaction(...)` (via `swapV3`).
  - Requires: RPC HTTP endpoint (`SOLANATRACKER_RPC_HTTP_URL`, or `swapConfig.rpcUrl` fallback).
- SolanaTracker Swap API (via `swapV3.buildSwapTx`):
  - HTTP GET to swap builder base URL (default `https://swap-v2.solanatracker.io/swap`).
  - Required query params: `from`, `to`, `fromAmount`, `slippage`, `payer`.
  - Optional query params: `priorityFeeLevel`, `txVersion`.
  - Required header: `x-api-key`.

### `lib/swap/swapV3.js` (swap pipeline)
- Swap builder HTTP call:
  - Endpoint: `swapApiBaseUrl` (defaults to `/swap`).
  - Required: `from`, `to`, `fromAmount`, `slippage`, `payer`.
  - Optional: `priorityFeeLevel`, `txVersion`.
  - Required: `x-api-key`.
- Solana RPC calls:
  - `rpc.simulateTransaction(base64, { encoding: 'base64' })` when `swapConfig.preflight=true`.
  - `rpc.sendTransaction(base64, { encoding: 'base64' })` always (unless `dryRun`).

### `lib/warchest/workers/txMonitorWorker.js` (confirmation)
- SolanaTracker RPC:
  - WebSocket subscriptions for signature confirmation.
  - HTTP calls for transaction details/fallbacks (via `rpcMethods`).
  - Requires: RPC HTTP endpoint.
- BootyBox (SQLite):
  - Persists swap/trade outcomes and wallet balances.
  - Requires: DB initialized + schema present.

### 1) CLI entrypoint (command parsing)

Location: `lib/cli/swap.js`

Required inputs:

- `mint` (string, base58) - token mint address.
- `--buy <amount>` OR `--sell <amount>` (string/number).

Optional inputs:

- `--wallet <alias>` (string) - wallet alias from registry.
- `--dry-run` (boolean) - build/sign but do not send.
- `--detach` (boolean) - run txMonitor in a detached process.

Units:

- Buy amount is SOL in **human units** (decimal number).
- Sell amount is token amount in **human units**, or `%`/`auto`.

Output: a swap payload object passed to the hub coordinator.

### 2) Swap payload (CLI → hub)

Location: `lib/cli/swap.js` → `hub.runSwap(payload, options)`

Payload shape:

- `side` (required) - `"buy"` or `"sell"`.
- `mint` (required) - base58 mint string.
- `amount` (required) - number or string (`"50%"`, `"auto"`).
- `walletAlias` (required if no `walletPrivateKey`) - registry alias.
- `walletId` (optional) - numeric/opaque id used by BootyBox.
- `walletPubkey` (optional) - base58.
- `dryRun` (optional) - boolean.
- `panic` (optional) - boolean (CLI sets for sell-all flows).
- `detachMonitor` (optional) - boolean.

Units:

- `amount` is **human units**.
  - Buy: SOL.
  - Sell: token amount, or percent/auto of current position.

Where sent:

- Serialized over IPC to `swapWorker` via hub coordinator.

### 3) swapWorker validation + wallet secret

Location: `lib/warchest/workers/swapWorker.js`

Validations:

- `side` must be `buy` or `sell`.
- `mint` must be base58 (32–44 chars).
- `amount` must be a positive number, or `%`/`auto` (sell only).
- Requires `walletAlias` or `walletPrivateKey`.

Wallet secret resolution:

- If `walletPrivateKey` is present: use it directly.
- Otherwise: `getWalletPrivateKey(walletAlias)` loads from registry/keychain.

Accepted secret formats:

- Base58 string (32/64 bytes after decode).
- JSON array (`[u8, u8, ...]`).

Units:

- Secrets are raw key bytes; wallet pubkey is base58 string.

### 4) Sell sizing (percent/auto only)

Location: `lib/warchest/workers/swapWorker.js` → `resolveFromAmountDecimal`

If sell amount is `%` or `auto`:

- BootyBox (`db/`) loads current position for `walletAlias` + `mint`.
- `auto` → entire position amount (human units).
- `%` → `position * percent / 100`.

Units:

- Position sizes are **human units** (token decimals).

Where it is sent:

- This resolution happens locally, not over the network.

### 5) Load swap config

Location: `lib/swap/swapConfig.js` (via `loadConfig()`)

Key fields (required in practice):

- `swapApiKey` (string) - API key for swap builder.
- `rpcUrl` (string) - SolanaTracker RPC HTTP URL.

Key fields (optional):

- `swapApiBaseUrl` (string) - Swap builder base URL.
- `slippage` (number, percent).
- `priorityFeeLevel` (string, e.g. `low`, `medium`, `high`).
- `txVersion` (`v0` or `legacy`).
- `useJito` (boolean).
- `jitoTip` (number, SOL).
- `showQuoteDetails` (boolean).
- `DEBUG_MODE` (boolean).
- `preflight` (boolean).
- `maxPriceImpact` (number or null, percent).
- `inkMode` (boolean).
- `explorerBaseUrl` (string).

Units:

- `slippage` is **percent**.
- `jitoTip` is **SOL** (human units).

Where it is sent:

- The config is used locally to derive swap parameters and RPC/client settings.
  The swap API key and base URL are sourced from this config, not from env.

### 6) Build swap transaction (Swap API request)

Location: `lib/swap/swapV3.js` → `buildSwapTx()`

Required inputs (from `swapWorker`):

- `from` (mint string) - `WSOL` for buys, token mint for sells.
- `to` (mint string) - token mint for buys, `WSOL` for sells.
- `fromAmount` (number) - **human units**.
- `slippagePercent` (number) - **percent**.
- `payer` (wallet pubkey string).
- `baseUrl` (string) - swap API base URL.
- `apiKey` (string) - swap API key.

Optional inputs:

- `priorityFeeLevel` (string).
- `txVersion` (string, `v0` or `legacy`).

Where it is sent:

- HTTP GET to `{swapApiBaseUrl}` (default `https://swap-v2.solanatracker.io/swap`)
- Query params: `from`, `to`, `fromAmount`, `slippage`, `payer`, and optional `priorityFeeLevel`, `txVersion`
- Header: `x-api-key: <swapApiKey>`

Response:

- `txn` (base64 wire transaction, required)
- `rate` / `quote` (shape varies by API version)

Units:

- `fromAmount` is **human units** (decimal).
- `slippage` is **percent**.

### 7) Sign transaction (local)

Location: `lib/swap/swapV3.js`

Process:

- Base64 `txn` is decoded to a transaction object.
- Transaction is signed with the wallet keypair.
- Signed transaction is re-encoded to base64 wire format.

Units:

- Base64 wire transaction (string).

Where it is sent:

- No network call; local signing only.

### 8) Optional preflight (simulation)

Location: `lib/swap/swapV3.js`

Trigger:

- `swapConfig.preflight=true` in swap config.

Where it is sent:

- `rpc.simulateTransaction` with `{ encoding: 'base64' }`.

Units:

- Base64 wire transaction.

### 9) Send transaction (RPC)

Location: `lib/swap/swapV3.js`

Required inputs:

- Signed base64 wire transaction.

Where it is sent:

- `rpc.sendTransaction(signedWireB64, { encoding: 'base64' })`.

Response:

- `txid` (signature string).

Units:

- Base64 wire transaction.
- `txid` is base58 signature.

### 10) swapWorker result (swap summary + monitor payload)

Location: `lib/warchest/workers/swapWorker.js`

Return fields:

- `txid`, `signature` (base58 string).
- `slot` (number or null).
- `quote` (object, API dependent).
- `tokensReceivedDecimal` (number, **human units**).
- `solReceivedDecimal` (number, **human units**).
- `totalFees` (number, **SOL**).
- `priceImpact` (number, **percent**).
- `dryRun` (boolean).
- `timing` (ms timestamps).
- `monitorPayload` (object, used by txMonitor).
- `monitorDetach` (boolean).

`monitorPayload` fields:

- `txid` (base58 signature).
- `wallet` (wallet pubkey or alias).
- `walletAlias`, `walletId`.
- `mint`, `side`, `size`.
- `slippagePercent`, `priorityFeeLevel`, `txVersion`.
- `swapQuote` (quote + raw API payload).
- `txSummarySeed` (summary shell for HUD/logging).
- `explorerBaseUrl` (string, optional).
- `inkMode` (boolean).

Units:

- `size` is **human units** (amount from CLI/config).
- Fees are **SOL** (human units).
- Price impact is **percent**.

Where it is sent:

- Returned over IPC to the CLI process via hub.

### 11) txMonitor (confirmation + persistence)

Location: `lib/warchest/workers/txMonitorWorker.js`

Triggers:

- CLI invokes `hub.runTxMonitor(monitorPayload, options)`.
- If `--detach`, worker is spawned detached and the payload is stored in
  `data/warchest/tx-monitor-requests/`.

What it does:

- Watches the signature until a terminal status (confirmed/failed).
- Emits HUD events and writes trade outcomes into BootyBox.
- Enriches summary/logs with insight data.

Where it is sent:

- SolanaTracker RPC WebSocket + HTTP (via `createSolanaTrackerRPCClient`).

Units:

- Signature is base58.
- Timeouts are milliseconds.

## Key environment variables referenced by the workflow

RPC + Data API:

- `SOLANATRACKER_RPC_HTTP_URL` - HTTP RPC endpoint.
- `SOLANATRACKER_API_KEY` - Data API key (used by data clients, not swap).
- `SOLANATRACKER_DATA_ENDPOINT` - data API base URL (passed through to workers).

Swap behavior (config-driven):

- `swapConfig.preflight` - enable preflight simulation.
- `swapConfig.maxPriceImpact` - max allowed price impact (%).
- `swapConfig.swapApiBaseUrl` - swap builder base URL.
- `swapConfig.swapApiKey` - swap builder API key.
- `swapConfig.inkMode` - Ink UI mode (reduces logs for TTY UI).

Worker behavior:

- `SWAP_WORKER_EXECUTOR` - test-only swap executor module path.

## Where to refactor for a new swap API

Primary swap integration points:

- `lib/swap/swapV3.js` (`buildSwapTx` + send pipeline)
- `lib/warchest/workers/swapWorker.js` (config/inputs/outputs)

Secondary integration points:

- `lib/cli/swap.js` (payload shape, progress events)
- `lib/swap/swapConfig.js` (API config defaults)
- `lib/warchest/workers/txMonitorWorker.js` (post-send persistence)
