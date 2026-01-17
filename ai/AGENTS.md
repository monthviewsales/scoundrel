# ai/

Rules for all LLMs generating code in the /ai directory.
Inherits root `AGENTS.md`; local rules add/override.

## Clients
- Do NOT import or destructure global clients at module load.
- Workers create their own isolated AI client.
- AI jobs MUST accept a client via factory: createXJob(client).

## Job Modules
- Every job module MUST export:
  - createXJob(client) → { runXJob }
  - runXJob (default instance using defaultClient)

## Pattern
```js
const defaultClient = require('../client');

function createXJob(client) {
  const { callResponses, parseResponsesJSON, log } = client;
  async function runXJob(args) { ... }
  return { runXJob };
}

const { runXJob } = createXJob(defaultClient);
module.exports = { createXJob, runXJob };
```

## Shared Patterns
- For creating new CLI analysis flows (dossier/autopsy/devscan pattern), follow `docs/analysis-flow-factory.md`.

## Forbidden
- ❌ `const { callResponses } = require('../client')` (no global destructuring)
- ❌ Creating AI clients inside runXJob
- ❌ Binding AI logic to Hub or shared state

## Schemas
- Every job MUST reference a schema under /ai/schemas.
- Schema changes MUST bump the schema version.

## Worker Usage
```js
const client = createAIClient();
const { runXJob } = createXJob(client);
```

## Recent patterns (DevScan + Grok)
- DevScan summaries use Grok (xAI) client; keep the default client for that job as `grokClient`.
- Do not reuse `OPENAI_RESPONSES_MODEL` for Grok jobs. Use `xAI_API_MODEL` or the Grok default.
- Ensure the Grok client base URL includes `/v1` (`https://api.x.ai/v1`) to avoid 404s.
- If an AI job runs from a CLI flow, wire artifacts through `createCommandRun`:
  - raw payloads: `artifacts.write('raw', ...)`
  - prompt payloads: `artifacts.write('prompt', 'prompt', payload)`
  - response payloads: `artifacts.write('response', 'response', result)`
- Use `persistProfileSnapshot` for AI outputs when you want a consistent DB archive.

## Tests
- Add unit tests for new CLI AI flows under `__tests__/cli/`.
- Mock network and AI calls (e.g., `global.fetch`, job modules) and assert:
  - artifact write intent (`createCommandRun` → `artifacts.write`)
  - AI job invocation (or skip when `--raw-only` / `runAnalysis=false`)
  - persistence hooks (`persistProfileSnapshot`) when analysis runs
