# Swap Config TUI and Swap Pipeline Refactor

Date: 2025-12-21

## Summary
- Added an Ink-based swap configuration screen and removed per-swap CLI overrides.
- Centralized swap settings in the config file and simplified swap worker validation.
- Unified stablecoin detection using the shared stable mint registry.
- Added RPC diagnostics helpers and safer dotenv loading for workers/tests.

## Changes

### Swap config UX
- Added an Ink swap config screen at `scoundrel swap --config` with view/edit flow, type validation, and setting descriptions.
- Kept config file location unchanged (`swapConfig.json` in Application Support/XDG config paths).
- Made swap settings fully editable in the UI (swap API key is redacted when displayed).
- Added config settings: `swapApiBaseUrl`, `preflight`, `maxPriceImpact`, `inkMode`, `explorerBaseUrl`.

### Swap CLI and worker
- Removed `--slippage`, `--priority-fee`, and `--jito` from the swap CLI surface.
- Swap worker now loads swap config and applies slippage/priority/jito/txVersion/debug settings internally.
- Added wallet pubkey vs. private key mismatch guard in the worker (fails fast with clear error).
- Swap worker now reads swap API base URL/key and behavior flags directly from config (no swap env vars).
- Moved `validateSwapPayload` into `lib/swap/validateSwapPayload.js`.

### Swap engine / diagnostics
- Moved `fetchSignatureDiagnostics` into Solana RPC helpers and reused it in swap engine error handling.
- Added `getSignatureStatus` RPC helper and tests.
- Added development logging around custom send endpoints and swap options.

### Stablecoin registry
- Switched `txInsightService` stablecoin detection to `lib/solana/stableMints.js`.
- Added stable mint helper usage in swap engine, swap worker, and trades logging.
- Added tests for stable mint detection and txInsightService non-tradable handling.

### Runtime safety
- Added `lib/env/safeDotenv.js` to avoid blocking on non-regular `.env` files (FIFOs).
- Replaced direct dotenv loads in CLI and workers with safe dotenv loading.

## Tests
- `npm test`

## Files added
- `lib/tui/swapConfigApp.js`
- `lib/swap/validateSwapPayload.js`
- `lib/env/safeDotenv.js`
- `lib/solana/rpcMethods/getSignatureStatus.js`
- `lib/solana/rpcMethods/internal/fetchSignatureDiagnostics.js`
- `__tests__/solana/rpcMethods/getSignatureStatus.test.js`
- `__tests__/solana/rpcMethods/fetchSignatureDiagnostics.test.js`
- `__tests__/solana/stableMints.test.js`
- `__tests__/services/txInsightService.test.js`

## Files updated (high-level)
- `index.js`, `lib/cli/trade.js`
- `lib/warchest/workers/swapWorker.js`, `lib/swapEngine.js`, `lib/trades.js`
- `lib/services/txInsightService.js`
- `lib/swap/swapConfig.js`, `lib/swap/config.json`
- `lib/solana/rpcMethods/index.js`
- `lib/logger.js`, `lib/solanaTrackerRPCClient.js`, `lib/solanaTrackerDataClient.js`, `lib/cli/ask.js`, `lib/cli/tuneStrategy.js`, `lib/warchest/workers/warchestService.js`
- `README.md`, `docs/warchest_process_notes.md`
- `__tests__/warchest/workers/swapWorker.test.js`, `__tests__/warchest/workers/txMonitorChain.test.js`, `__tests__/warchest/hubCoordinator.test.js`
