# Coin Monitor Worker

`lib/warchest/workers/coinMonitorWorker.js` spawns a per-mint watcher that subscribes to token account and log updates for a wallet. It reuses the worker harness so parents can start/stop the monitor over IPC.

## Payload

- `mint` (string, required): token mint to track.
- `wallet` (object, required): `{ alias, pubkey, color? }` used for account lookups and logging.
- `exitOnZero` (boolean, default: `true`): stop when the aggregated mint balance reaches zero.
- `renderIntervalMs` (number, default: 1000): logging cadence for the CLI HUD.
- `statusDir` (string, optional): directory for status snapshots via `writeStatusSnapshot`.

## Exit conditions

- **Drained**: aggregated token balance at or below zero (default). Status is returned as `drained`.
- **Stopped**: explicit `stop` message sent to the worker or controller, or harness shutdown. Status is returned as `stopped`.
- **Errors**: bootstrap failures reject the harness call; subscription errors log warnings but keep running.

## Start/stop controls

- Worker mode: `createWorkerHarness` listens for `{ type: 'start', payload, requestId }` and returns the final status when the monitor exits.
- Stop message: send `{ type: 'stop' }` over IPC to request a graceful shutdown. The controller also exposes `.stop()` for in-process tests.
- Cleanup: subscriptions, intervals, and owned clients are cleaned up before responding.
