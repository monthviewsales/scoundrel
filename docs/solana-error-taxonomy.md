# Solana Error Taxonomy (Scoundrel)

This document summarizes how Scoundrel classifies Solana/RPC errors for logging,
HUD events, and future automation.

## Goals

- Provide a stable, reusable error summary that can be emitted in logs and HUD events.
- Distinguish transport/RPC failures from on-chain program failures.
- Preserve raw error data while surfacing a human-friendly `userMessage`.

## Where Classification Happens

- `lib/solana/errors/index.js` exports the classifier helpers.
- `lib/solanaTrackerRPCClient.js` uses the classifier to log RPC errors and retries.
- `lib/warchest/workers/txMonitorWorker.js` attaches `errorSummary` to HUD events.
- `lib/warchest/workers/swapWorker.js` logs classification details on swap failures.

## Error Summary Shape

Each error is normalized to:

```json
{
  "kind": "simulation_failed",
  "message": "Transaction simulation failed",
  "userMessage": "Transaction simulation failed (preflight). Check logs for the failing instruction.",
  "retryable": false,
  "code": "-32002",
  "solanaErrorCode": "JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE",
  "programError": {
    "programId": "RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87",
    "programError": "0x178b",
    "anchorError": { "name": "CalculationError", "number": 6027 }
  },
  "logs": [ "Program ...", "Program log: ..." ]
}
```

Notes:
- `code` is usually a JSON-RPC or transport error code (stringified).
- `solanaErrorCode` is provided when the error is a `SolanaError` from `@solana/kit`.
- `programError` is extracted from log lines (Anchor errors and `custom program error` codes).

## Taxonomy (Current Kinds)

| kind | Meaning | Typical Cause |
| --- | --- | --- |
| `simulation_failed` | Preflight simulation failed | Program error, invalid accounts, compute issues |
| `preflight_failed` | RPC preflight rejected | RPC validation or simulation error |
| `blockhash_not_found` | Blockhash is missing | Stale blockhash or RPC behind |
| `transaction_expired` | Confirmation window elapsed | Congestion or slow propagation |
| `signature_missing` | Missing signatures | Unsigned transaction |
| `tx_size_exceeded` | Transaction too large | Too many instructions/accounts |
| `compute_exceeded` | Compute budget exceeded | Heavy instruction path |
| `rpc_transport` | HTTP transport failed | Network/RPC outage (`fetch failed`) |
| `ws_connect` | WebSocket connect failed | RPC WS unavailable |
| `program_error` | On-chain program error | `custom program error: 0x...` or Anchor error |
| `instruction_error` | Instruction error | Explicit InstructionError index + detail |
| `unknown` | Not classified | Any other error |

## Retry Behavior

Retries are applied only to **read-only RPC methods** and **transport errors**:

- Read-only methods include `getBalance`, `getBlockTime`, `getTokenAccountsByOwner`, `getTransaction`, etc.
- Retry configuration is controlled by:
  - `KIT_RPC_MAX_RETRIES` (default `1`)
  - `KIT_RPC_RETRY_BASE_MS` (default `200`)
  - `KIT_RPC_RETRY_MAX_MS` (default `2000`)

Transactions (`sendTransaction`) are **not retried** automatically.

## HUD Events

Tx monitor HUD events include `errorSummary` when available:

- `data/warchest/tx-events.json` entries will contain:
  - `txSummary.errorSummary`
  - `errorSummary` at the top level of the event

This keeps the UI/HUD consistent with log output.

## Updating the Taxonomy

When adding new error handling:

1. Extend `classifySolanaError()` in `lib/solana/errors/index.js`.
2. Update this doc with the new `kind` and meaning.
3. Ensure `userMessage` is concise and actionable.
4. Preserve raw logs where possible for support/debugging.
