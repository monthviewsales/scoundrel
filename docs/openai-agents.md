# OpenAI Agents (local cache)

Retrieved: 2026-01-09
Sources:
- https://platform.openai.com/docs/guides/agents
- https://platform.openai.com/docs/guides/agent-builder
- https://platform.openai.com/docs/guides/agents-sdk
- https://platform.openai.com/docs/guides/chatkit
- https://platform.openai.com/docs/guides/agent-evals
- https://platform.openai.com/docs/guides/trace-grading
- https://platform.openai.com/docs/guides/evaluation-getting-started
- https://platform.openai.com/docs/guides/prompt-optimizer
- https://platform.openai.com/docs/guides/node-reference
- https://platform.openai.com/docs/guides/tools-file-search

## High-level overview
- Agents are systems that accomplish tasks with workflows composed of models, tools, knowledge, and control flow.
- OpenAI positions "AgentKit" as a toolkit for building, deploying, and optimizing agents.
- Primary paths:
  - Agent Builder (visual workflow canvas)
  - Agents SDK (code-first agentic apps)
  - ChatKit (embeddable chat UI for agent workflows)
  - Evals tooling (trace grading, datasets, prompt optimizer)

## Agent Builder (workflow design)
- Visual canvas to compose multi-step workflows.
- Start from templates or build from scratch.
- Key steps: design workflow -> publish (versioned ID) -> deploy.
- Deployment options:
  - ChatKit (hosted workflow backend)
  - Advanced integration (export SDK code and run your own backend)
- Preview and debug runs with live data.
- Notes emphasize safety (prompt injection, data leakage) and the use of evals.

## Node reference (Agent Builder building blocks)
- Core nodes:
  - Start: defines inputs and appends user input to conversation history.
  - Agent: instructions, model configuration, tools, evals.
  - Note: documentation-only, no execution.
- Tool nodes:
  - File search: query OpenAI-hosted vector stores.
  - Guardrails: detect unsafe or unwanted outputs; enforce pass/fail gates.
  - MCP: connect to third-party tools and services.
- Logic nodes:
  - If/else and While: control flow via Common Expression Language (CEL).
  - Human approval: pause for user sign-off before continuing.
- Data nodes:
  - Transform: reshape outputs to match schemas.
  - Set state: define global variables for downstream nodes.

## Agents SDK
- Code-first SDK for agentic applications with tool use, handoffs, streaming, and tracing.
- Supported in Python and TypeScript.
- Docs live in SDK-specific sites.

## ChatKit (deployment)
- Embeddable chat UI for agent workflows.
- Two integration modes:
  - Recommended: embed UI, OpenAI hosts the workflow backend (Agent Builder workflows).
  - Advanced: run on your infrastructure and connect any agent backend via SDKs.
- Uses a session token model with a server endpoint creating sessions.
- Supports widgets, theming, actions, file attachments, and tool invocations.

## Agent evals and optimization
- Agent evals: evaluation tools to measure agent quality.
- Trace grading:
  - Score or label end-to-end traces to diagnose where workflows succeed or fail.
  - Use graded traces to build trace evals and monitor regressions.
- Datasets:
  - Create datasets in the platform UI; add prompts, generate outputs, annotate.
  - Add graders (string check, text similarity, LLM scorers, or code execution).
- Prompt optimizer:
  - Uses datasets + grader feedback to improve prompts.
  - Iterate: optimize -> review -> regenerate outputs -> annotate -> optimize.

## File search tool (Responses API)
- Hosted tool for semantic and keyword retrieval from OpenAI vector stores.
- Requires: upload files, create vector store, attach file to vector store.
- Usage: include a file_search tool with vector_store_ids in Responses API calls.
- Supports result limits, include search results in responses, and metadata filtering.
- Supported file types include text, code, and PDFs (see the docs for full list).

## Practical notes for this repo
- Current gptClient uses the Responses API with JSON schema structured outputs.
- Agent Builder features map well to a centralized orchestration layer:
  - Tool nodes -> MCP or internal tool registry
  - Logic nodes -> explicit branching / approval steps
  - Trace grading -> evaluation harness for responses
