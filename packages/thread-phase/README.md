# thread-phase

A general-purpose phase-based agentic pipeline framework for TypeScript.

Compose multi-step agent workflows out of small, typed phases. Each phase has its own model tier, tool set, and token budget. Inference is OpenAI-compatible by default — runs against vLLM, OpenAI, Ollama, llama.cpp, or anything that speaks `/v1/chat/completions`.

## Status

`v0.0.1` — phase framework, agent runner, JobStore, patterns, tool registry. 57 tests passing.

## Why

Long agent prompts mash multiple cognitive steps into one model call: classification, planning, tool use, synthesis, verification. The result is hard to test, hard to debug, expensive, and brittle to prompt edits.

`thread-phase` splits those steps into composable phases. Each phase:

- Reads typed inputs from a shared `PipelineContext` (with loud preconditions if a prior phase didn't run).
- Calls one specialized agent with its own system prompt, tool list, and model tier.
- Writes typed outputs back to context.
- Yields streamed progress events.
- Can short-circuit the rest of the pipeline by setting `ctx.stop`.

A pipeline is just an ordered list of `yield* phase.run(ctx)` calls. No DAG framework.

## Design

| Module | What it does |
|---|---|
| `phase.ts` | `Phase`, `PipelineContext<T>`, `requireCtx` |
| `orchestrator.ts` | Runs a list of phases, owns terminal events |
| `agent-runner.ts` | Tool-use loop, token budget, retry, JSON parse |
| `cache.ts` | Per-pipeline in-memory cache |
| `context/` | Token budget tracker, result capper, message compressor |
| `tools/` | Tool registry + executor (downstream registers its own) |
| `session/` | Persisted event log (sqlite default), resumable streams |
| `patterns/` | Reusable phase templates: parallel fan-out, intent gate, preflight confidence, synthesize-with-followup, spot-check |

## Inference provider

Driven entirely by env vars. See `.env.example`.

```
INFERENCE_BASE_URL=http://localhost:8000/v1
INFERENCE_API_KEY=not-needed-for-local-vllm
INFERENCE_MODEL=qwen3.6-27b
```

The framework assumes OpenAI-compatible chat completions with tool calls. Tested first against vLLM with `--tool-call-parser qwen3_xml`.

## Status, limits, what's next

- `npm test` — 49 tests across phase, cache, orchestrator, parseJSON, sanitizeToolPairs, ToolRegistry, SqliteJobStore.
- `npm run smoke` — 4-stage end-to-end smoke against the configured inference endpoint.
- See [`ROADMAP.md`](./ROADMAP.md) for known limitations, deferred features, and architectural cleanups grouped by severity.

## License

MIT. See `LICENSE`.
