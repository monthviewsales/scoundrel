# Scoundrel Overview (for LLMs)

Scoundrel is a Node.js CLI (CommonJS) that pairs SolanaTracker data with OpenAI Responses to profile wallets, autopsy trades, and manage a local “warchest” registry. Use this page to answer high-level questions without digging through the codebase.

## What it does
- Harvests trades, charts, and metadata for Solana wallets via the SolanaTracker Data API/SDK.
- Generates schema-locked JSON + markdown reports with the OpenAI Responses API.
- Persists artifacts locally (`./profiles`, `./data/dossier`, `./data/autopsy`) and in MySQL through the shared BootyBox helper.
- Provides operator tooling: dossier (profile builder), autopsy (single-mint campaign review), Q&A over saved profiles, and a wallet registry.

## Core commands (index.js)
- `research <wallet>` – harvest trades and token context for offline analysis.
- `dossier <wallet>` – harvest + build a profile via `ai/jobs/walletAnalysis.js`; supports `--resend` to rerun the last merged payload without re-harvesting.
- `autopsy` – interactive; pick a wallet + mint to run the `tradeAutopsy` job and save JSON to `./profiles/autopsy-*.json`.
- `ask -q <text> [-n <alias>]` – Q&A against `./profiles/<alias>.json`.
- `warchest [add|list|remove|set-color|options]` – manage the local wallet registry stored via BootyBox.
- `test` – environment + dependency sanity check (no Jest).

## Data & AI flow
1) `lib/solanaTrackerDataClient.js` binds the official `@solana-tracker/data-api` SDK to per-endpoint helpers under `lib/solanaTrackerData/methods/` (each with Jest coverage). RPC helpers live under `lib/solana/rpcMethods/` when raw RPC access is needed.
2) Harvesters (e.g., `lib/dossier.js`, `lib/autopsy.js`) gather trades, OHLCV, metadata, and assemble merged payloads under `./data/dossier/<alias>/` and `./data/autopsy/<wallet>/<mint>/`.
3) AI jobs in `ai/jobs/*.js` call `ai/client.js` (Responses API) with strict schemas from `ai/schemas/`; parsed output writes to `./profiles/` and, when configured, to MySQL via BootyBox.
4) DB access is centralized through the `packages/BootyBox` submodule (adapter chosen via `DB_ENGINE`, default sqlite); higher-level persistors sit in `lib/persist/`.

## Key directories
- `index.js` – CLI wiring + help text; keep new commands here consistent with Commander patterns.
- `commands/` – standalone command handlers (e.g., `warchest.js`).
- `lib/` – processors (`dossier.js`, `autopsy.js`, `ask.js`, `tuneStrategy.js`), SolanaTracker data/RPC helpers, persistence, logging, ID issuance.
- `ai/` – OpenAI client, structured-output jobs, and JSON schemas.
- `profiles/` (generated) – saved dossiers/autopsies; used by `ask`.
- `data/` (generated) – raw/merged harvest artifacts for debugging or resend mode.
- `docs/` – this overview, SolanaTracker helper docs, and codex task prompts.

## Runtime requirements
- Node.js 22+, MySQL reachable per `DB_*` env vars.
- Env vars: `OPENAI_API_KEY`, `SOLANATRACKER_API_KEY`, optional `OPENAI_RESPONSES_MODEL` (default `gpt-5.1` in `ai/client.js`), `NODE_ENV`, `DB_ENGINE`/`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`.
- Install deps: `npm install`. Run tests: `npm test` (Jest, per-module coverage expected). Lints run via `npm run lint` if configured.

## Coding conventions to remember
- CommonJS only; no ESM.
- Add JSDoc for exported functions/classes; keep helpers small and focused.
- Tests required for new/changed modules, especially SolanaTracker helpers and AI jobs.
- Respect logging rules: verbose in `development`, minimal in `production`; avoid noisy output in core paths.
- Keep CLI help flags (`-h`, `--help`) accurate and avoid breaking existing flags.

## Common talking points for Q&A
- **Purpose**: Analyze top wallets to derive trading styles and validate strategies before bots act.
- **Data source**: SolanaTracker Data API for wallet trades/metadata + optional RPC helpers for balances/accounts.
- **AI usage**: Responses API with strict schemas; outputs are deterministic JSON + optional markdown summary.
- **Persistence**: Artifacts in `./profiles` + MySQL via BootyBox tables (`sc_*`), ensuring shared pool reuse.
- **Safety**: No WebSocket/datastream use; HTTP endpoints only. Errors are contextualized and surfaced (no silent failures).

Use this overview to orient the model before deeper questions about implementation details, tests, or endpoint behaviors.
