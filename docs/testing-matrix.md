# Testing Matrix

This repo uses a mix of unit tests and CLI-oriented checks. Run only what you need.

## Core test commands

- `npm test` — Full Jest suite with open handle detection.
- `npm run test:ci` — CI-grade Jest run with coverage (outputs to `artifacts/coverage/`).
- `npm run lint` — Syntax validation of all `.js` files.

## RPC/WebSocket smoke check

Run this when verifying SolanaTracker credentials or network access:

```bash
node scripts/testRpcSubs.js
```

Notes:
- Requires `SOLANATRACKER_RPC_HTTP_URL` and `SOLANATRACKER_RPC_WS_URL`.
- Optional: set `TEST_PUBKEY` to test account subscriptions.

## When to use what

- Code changes: `npm test` + `npm run lint`.
- CI parity: `npm run test:ci`.
- RPC/WS troubleshooting: `node scripts/testRpcSubs.js`.
