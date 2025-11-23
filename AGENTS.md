# AGENTS.md

This file is for **AI coding agents** (and other automation) working on this repository.
Humans should prefer `README.md` for project overview and usage.

Agents **must** read and follow this document before making any changes.

---

## Setup & Commands

Use these commands when planning, testing, or validating changes.

- Install dependencies:  
  - `npm install`
- Run unit tests (Jest):  
  - `npm test`
- Run lints / static checks (if configured):  
  - `npm run lint`
- Run the CLI in development mode:  
  - `NODE_ENV=development <CLI_ENTRYPOINT> ...`
- Run the CLI in production mode:  
  - `NODE_ENV=production <CLI_ENTRYPOINT> ...`

> **Agent note:** If you discover more accurate commands (e.g. via `package.json`), prefer those and update this file instead of guessing.

---

## Code Style & Structure

Follow these rules for **all new and modified code**:

- **Module system**
  - Use **CommonJS** everywhere.
  - Imports: `const foo = require('./foo');`
  - Exports: `module.exports = { ... }` or `module.exports = function () { ... };`
  - Do **not** introduce ESM (`import` / `export`) without explicit instructions.

- **Documentation**
  - Use **JSDoc** for:
    - Every exported function.
    - Public classes / constructors.
    - Non-trivial internal helpers where behavior isn’t obvious.
  - JSDoc should document:
    - Parameters (`@param`)
    - Return type (`@returns`)
    - Error behavior when relevant (`@throws`)

- **Patterns**
  - Prefer small, single-responsibility modules.
  - Keep side effects at the edges (CLI entrypoints, process integration, network calls).
  - Larger services factories should be in /services and imported as needed.

### SolanaTracker clients

- docs/solanaTrackerData.md contains additional technical info about the SolanaTracker clients.
- **RPC** helpers live in `lib/solana/rpcMethods/`; **Data API** helpers live in `lib/solanaTrackerData/methods/`.
- Every Data API method belongs in its own file + Jest test (`__tests__/solanaTrackerData/methods/<name>.test.js`) and is bound via `lib/solanaTrackerDataClient.js`.
- All helpers must go through the shared retry/logger context (`createDataClientContext`) and expose meaningful errors (`DataApiError`).
- **Risk** (`getTokenRiskScores`) must continue returning `{ token, score, rating, factors, raw }` and keep factor/severity parsing in sync with docs.
- **Search** (`searchTokens`) must support arrays → comma lists and nested objects → JSON strings while rejecting empty filter sets.
- Datastream/WebSocket access is off limits; stick to HTTP endpoints only.

---

## Testing (Jest Requirements)

Testing is **not optional**. Every code change must respect:

- **Per-module coverage**
  - Each module should have a corresponding Jest test file (e.g. `foo.js` → `foo.test.js` or similar convention already in the repo).
- **Per-function coverage**
  - Each exported function must have tests covering:
    - Normal / success path.
    - At least one failure / edge case, where applicable.

- **Commands**
  - Default test command: `npm test`

> **Agent rule:**  
> If you create or significantly modify a module or function and **do not** add/update Jest tests, treat that as an error and either:
> - add the missing tests, or  
> - explicitly annotate in code comments *why* tests were not updated (for human review).

---

## CLI Conventions

This project is a **CLI tool** (Scoundrel). All CLI work must follow these rules:

- **Help flags**
  - Every command and subcommand must support:
    - `-h`
    - `--help`
  - Help output should:
    - Briefly describe the command.
    - List required/optional arguments.
    - Show at least one usage example when appropriate.

- **Man pages / usage docs**
  - Commands must have corresponding **man-style** or dedicated help/usage documentation.

- **Breaking changes**
  - Do **not** remove or rename existing flags or commands without explicit instructions.

---

## Environments & Logging

Scoundrel respects `NODE_ENV` and logging levels. Agents must **not** add noisy logs to production paths.

- **Environment**
  - `NODE_ENV=development`: verbose logs allowed.
  - `NODE_ENV=production`: logs must be minimal.

- **Logging rules**
  - Prefer a central logging utility.
  - Use `debug` / `trace` for verbose details in dev only.
  - `info` for high-level events.
  - `warn` / `error` for failures.

---

## Error Handling

Errors must be **trapped, contextualized, and logged** instead of silently swallowed.

---

## Agent Behavior Guidelines

Rules for AI coding agents:

- Do not guess architecture.
- Keep changes small and focused.
- Match surrounding style.
- Prefer updating this file over divergent behavior.
- Never introduce new dependencies without explicit instruction or permission.
- Unit testing must pass before the end of your turn.
- After changes review & update the README.md for accuracy.  Its goal is to be an overview and getting started guide for humans and AI agents.

---

## Things Agents Should Avoid

Do **not**:
- Convert to ESM or TypeScript.
- Remove or bypass tests.
- Add excessive logging.
- Create breaking CLI changes.
- Silence errors without context.
