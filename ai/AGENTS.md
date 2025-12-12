# ai/

Rules for all LLMs generating code in the /ai directory.

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