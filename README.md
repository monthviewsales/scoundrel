## Requirements

- A [SolanaTracker.io](https://www.solanatracker.io/?ref=0NGJ5PPN) account (used for wallet and trade history).  
- An [OpenAI](https://openai.com/) account and the knowledge to operate its APIs.  

# Scoundrel — a VAULT77 🔐77 relic

> *Unearthed from VAULT77, Scoundrel is a relic software tool built for trench operators.  
> It harvests and analyzes the trading patterns of top wallets, relays strategies, and keeps the link open to save our futures.*

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

3. **Integrate with Warlord Bot**  
   Use the outputs from the analysis layer as a validator module inside the bot. When the bot signals a buy, Scoundrel provides a second opinion to confirm, size, or veto the trade.

4. **Balance Speed with Explainability**  
   Keep the core signals fast and deterministic, while using OpenAI models for policy validation, risk rules, and human-readable rationale.

---

## Roadmap to Success

### Phase 1 — Data Harvesting
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

---

## Requirements

- A [SolanaTracker.io](https://www.solanatracker.io/?ref=0NGJ5PPN) account (Data API for wallet trades & chart).
- An [OpenAI](https://openai.com/) account and API key (Responses API).
- Node.js 22 LTS and npm.

---

## What’s new (Nov 2025)

Scoundrel has been refactored to a **Responses‑first** architecture. No Assistants, no Chat Completions, no thread state. We send **JSON in** and get **schema‑locked JSON out**.

**Highlights**
- Clean AI backbone: `/ai/client.js` (Responses) + `/ai/jobs/*` + `/ai/schemas/*`.
- Processors in `/lib` are called directly by the CLI (no thin shims):
  - `harvestwallet.js` → pulls trades + chart and (optionally) calls an AI job.
  - `ask.js` → Q&A over a saved profile.
  - `tune.js` → strategy tuning proposals.
- Deterministic outputs via **JSON Schema (strict)**.
- Quiet, predictable logging (`NODE_ENV=production` by default).

---

## Architecture

```
SolanaTrackerDataClient ──▶ /lib/harvestwallet.js
                          └─ trades + chart (raw JSON)

/lib/harvestwallet.js ──▶ /ai/jobs/walletAnalysis.js ─▶ /ai/client.js (Responses API)
                          └─ { meta, trades, chart }      └─ json_schema (strict)

CLI commands ───────────▶ /lib/*.js processors           └─ writes deterministic JSON artifacts
```

- **Data Source**: SolanaTracker Data API (`getWalletTrades`, `getWalletChart`).
- **AI Jobs**: Small, single‑purpose modules that construct a request (system + user + schema) and call the **Responses API**.
- **Schemas**: Versioned under `/ai/schemas/…` and kept strict (`additionalProperties: false`, explicit `required`).

---

## Install

```bash
npm install
cp .env.sample .env    # add your keys
```

### Environment

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `OPENAI_API_KEY` | ✅ | – | OpenAI Responses API key |
| `OPENAI_RESPONSES_MODEL` |  | `gpt-4.1-mini` | Model used by all jobs |
| `SOLANATRACKER_API_KEY` | ✅ | – | SolanaTracker Data API key |
| `NODE_ENV` |  | `production` | `development` enables verbose logs & samples |
| `HARVEST_LIMIT` |  | `500` | Default trade limit when not provided via CLI |
| `SAVE_RAW` |  | `false` | If `true`, save full raw payloads in `./data/` |

---

## Commands

> Run `node index.js --help` or append `--help` to any command for flags & examples.

### `build-profile <WALLET>`
Harvest trades + chart and build a **schema‑locked profile** via OpenAI Responses.

- Writes to `./profiles/<alias-or-wallet>.json`.
- Writes small raw samples to `./data/` in development (and full dumps when `SAVE_RAW=true`).

Examples:
```bash
node index.js build-profile 2kv8X…Rva9 -n Gh0stee -l 500
node index.js build-profile <WALLET> --start 2025-01-01T00:00:00Z --end 2025-01-31T23:59:59Z
```

### `ask`  
Ask a question about a trader using their saved profile (Responses API).

- Reads `./profiles/<name>.json` for context.
- Returns a concise answer; may include bullets and suggested actions.

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

- `./profiles/<name>.json` — final, schema‑locked profile JSON (output of Responses API).
- `./data/` — development‑time samples and (optionally) full raw downloads used to reproduce a run:
  - `<wallet>-raw-sample-<runId>.json`
  - `<wallet>-chart-sample-<runId>.json`
  - when `SAVE_RAW=true`: `<wallet>-raw-<runId>.json`, `<wallet>-chart-<runId>.json`

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