# Analysis Flow Factory

This repository uses a shared factory to standardize CLI analysis flows that:
1) build an enriched JSON payload from API data
2) write JSON artifacts (raw/prompt/response)
3) invoke an AI job
4) persist the analysis via flow-specific hooks

The factory lives at `lib/cli/analysisFlow.js` and is used by dossier, autopsy, devscan, and targetscan.

## Usage

```js
const { createAnalysisFlow } = require('../lib/cli/analysisFlow');

const runExampleFlow = createAnalysisFlow({
  command: 'example',
  logger,
  build: async ({ options, createArtifacts }) => {
    const runContext = createArtifacts(['segment']);
    const payload = await fetchAndBuildPayload(options);
    runContext.artifacts.write('raw', 'source', payload.raw);
    return { payload };
  },
  analyze: async ({ payload }) => runExampleJob({ payload }),
  persist: async ({ payload, analysis }) => persistExample({ payload, analysis }),
});
```

## Notes

- `build` may call `createArtifacts(segments, runId)` once it knows how to group artifacts.
- If `options.runAnalysis === false`, the flow writes the prompt artifact (unless the build
  returns `promptPath: null`) and skips the AI call.
- Returning `runAnalysis: false` or `skipAnalysis: true` from `build` skips analysis entirely.
- The CLI wrappers keep their existing run signatures and persistence hooks.
- Final payload assembly (prompt + response) and vector store uploads should happen inside `persist`
  so only merged payloads are uploaded.
