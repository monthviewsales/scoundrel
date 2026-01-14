# Warchest & SellOps Refresh Sources

This document explains where coin data is refreshed and how the HUD fields are derived.

## Warchest HUD refresh flow

The HUD updates coin rows inside `lib/warchest/workers/warchestService.js`.

### HUD timers (defaults)

- **SOL balance refresh:** `HUD_SOL_REFRESH_SEC` (default 15s).
- **Token refresh loop:** `HUD_TOKENS_REFRESH_SEC` (default 30s).
  - Alternates META vs PRICE on each tick.
- **HUD emit throttle:** `WARCHEST_HUD_EMIT_THROTTLE_MS` (default 100ms).
- **Fast wallet refresh debounce:** `WARCHEST_LOG_REFRESH_DEBOUNCE_MS` (default 750ms).
  - Used by per-wallet refresh scheduler to avoid hammering after log/tx events.

### Token row refresh cadence

- **Token balances + metadata** are refreshed on a periodic HUD tick.
- The tick alternates between **META** and **PRICE** modes:
  - **META mode**: calls `dataClient.getWalletTokens()` for wallet token metadata.
  - **PRICE mode**: skips metadata and only updates prices/balances.
- The same refresh loop also updates wallet SOL balances and loads PnL from the DB view.

### HUD data sources (per token row)

- **Balance**: derived from RPC token accounts (`rpcMethods.getTokenAccountsByOwner`) and aggregated per mint.
- **Symbol / Decimals**: read from `getWalletTokens()` metadata when available; otherwise preserved from the prior row.
- **priceUsd**:
  - Preferred: batched Data API price pull via `getMultipleTokenPrices({ mints })`.
  - Fallback: pool price from `getWalletTokens()` metadata (if present).
  - Fallback: prior row price.
- **USD estimate**: `priceUsd * balance` (stored as `usdEstimate`).
- **PnL/ROI** (position snapshot): from `sc_pnl_positions_live` view in SQLite via `refreshPnlPositions`.

### Why HUD updates can lag

- The tx feed is updated by tx monitor events immediately.
- Token rows only update on the HUD refresh tick, so a confirmed transaction can appear before the coin row updates.

## SellOps refresh flow

SellOps runs in `lib/warchest/workers/sellOpsWorker.js` and evaluates positions in
`lib/warchest/workers/sellOps/controller.js`.

### Evaluation refresh

- SellOps builds evaluations using `db/src/services/evaluationService.js`.
- Evaluation reads from DB tables/views:
  - `sc_coins` / pool / events / risk data (no write-back of prices).
  - `sc_pnl_positions_live` for ROI/PNL context.
- Evaluation may call Data API for OHLCV/indicators.
- Evaluation results are emitted to the HUD via `sellOps:evaluation` messages.
- Evaluation snapshots are persisted to `sc_evaluations` (`ops_type='sellOps'`) for historical review.

### SellOps timers (defaults)

- **Evaluation loop:** `payload.pollIntervalMs` (default 60s).
  - Set by the HUD sellOps orchestrator when it spawns workers.
- **Trailing stop loop:** `payload.trailingPollMs` or strategy defaults (default 5s).
  - `getTrailingStopConfig` reads from strategy docs; defaults live in `lib/warchest/workers/sellOps/stopLogicLoader.js`.

### Trailing-stop refresh

- Trailing stop loop polls with `dataClient.getMultipleTokenPrices(mints)`.
- These price ticks are **in-memory only** and are not persisted to SQLite.

## HUD field glossary

The HUD token row includes several value fields. These are derived as follows:

- **Est. USD** (`usdEstimate`)
  - Computed from HUD price * balance: `priceUsd * balance`.
  - Uses the HUD price refresh sources above.

- **Up/Down** (`positionLine`)
  - A compact line displaying ROI% only.
  - Uses the ROI% from `sc_pnl_positions_live` if present; otherwise computed as
    `(currentUsd - entryUsd) / entryUsd`.

- **uPnL** (unrealized PnL)
  - Derived from `sc_pnl_positions_live` (`unrealized_pnl_usd` or variants).
  - Represents PnL for open/unsold portion.

- **rPnL** (realized PnL)
  - Derived from `sc_pnl_positions_live` (`realized_pnl_usd` or variants).
  - Represents PnL already locked in by sells.

## Summary

- HUD prices are refreshed in the HUD worker, not by SellOps.
- SellOps trailing-stop prices are not persisted to the DB.
- PnL values come from `sc_pnl_positions_live`, which is updated by trade processing.
- SellOps evaluation snapshots are stored in `sc_evaluations` for later analysis.
