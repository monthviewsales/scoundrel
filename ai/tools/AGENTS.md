# ai/tools/

Rules for AI agents working in the /ai/tools directory.
Inherits `AGENTS.md` (root) + `ai/AGENTS.md`. Local rules add/override.

## Purpose

This directory defines the tool catalog used by agentic APIs.
Each tool exposes:
- a name (`domain.functionName`)
- a JSON Schema for parameters
- a handler (async-safe) that calls internal helpers

The catalog is exported via `ai/tools/index.js`:
- `listTools()` → array of tool schemas
- `callTool(name, args)` → dispatch to handlers

## Adding a Tool

1) Implement the tool entry in `ai/tools/registry.js`.
2) Use the `domain.functionName` naming convention.
3) Provide:
   - `description` (clear + concise)
   - `parameters` (JSON Schema, `additionalProperties: false`)
   - `handler` (async-safe, no side effects unless required)
4) The handler must:
   - validate required args through the schema
   - call existing helper modules (do not re-implement logic here)
5) Add unit tests in `__tests__/ai/tools.test.js` for:
   - `listTools()` includes the new tool
   - `callTool()` invokes it and returns expected output

## Constraints

- Keep the registry lightweight; no network calls here unless the helper requires it.
- Do not import or create AI clients in this directory.
- Prefer reusing helper modules in `/lib` or `/ai` over inline logic.
- If a tool creates a SolanaTracker data client, close it in a finally block.
