# thread-phase

A TypeScript framework for the iterated tool-use loop against OpenAI-compatible inference (vLLM, Ollama, OpenAI, llama.cpp), composed into multi-phase pipelines with a typed shared context, persistent event logs, and concurrency-capped fanout.

```bash
npm install thread-phase
```

> **Generating thread-phase code with an LLM agent?** See [`AGENTS.md`](./AGENTS.md) — a self-contained reference covering the mental model, a copy-paste template, and explicit anti-patterns.

## Use cases

thread-phase is designed for two shapes:

1. **Agent-authored automations.** When an autonomous agent (Claude Code, Hermes, Cursor, etc.) sets up a recurring task — a cron job, a systemd timer, a CI step — the structuring usually happens at prompt-write time but the execution still relies on the agent re-deriving its plan at run time. thread-phase gives the structuring agent a typed phase boundary to encode the deterministic parts of the pipeline (ordering, fan-out, ctx flow, post-condition checks) while leaving the run-time agent free to make judgment calls inside each phase. The cron line ends up being a plain `npx tsx ...` invocation; no prompt at run time. See [`examples/agent-authored-cron.ts`](./examples/agent-authored-cron.ts).

2. **Mini-workflows inside larger DAG frameworks.** Temporal, LangGraph, Inngest, and similar frameworks are built for distributed DAG orchestration; they're heavyweight when a single node needs to run a small multi-step agent loop with its own concurrency cap, retry, and event log. thread-phase fits as the *inside* of one node — Temporal owns the workflow topology and durable state across machines; thread-phase owns the streaming tool-use loop and per-node phase composition. This composes cleanly because thread-phase's `runAgentWithTools` and `runPipeline` don't assume they own the event loop or persistence layer.

It's also useful as a standalone pipeline runner (`JobRunner` + sqlite event log + SSE streaming) for batch-processing workloads that don't need either of the above.

## Out of scope

- DAG / graph framework features (cross-node dependency graphs, declarative edge routing, distributed scheduling). Use Temporal/LangGraph/Inngest, embedding thread-phase inside their nodes.
- Anthropic content-block model (vision, citations, extended thinking). Use the Anthropic SDK directly.
- Multi-modal inputs.
- Long-document summarization (the bundled compressor uses opaque markers for old tool results — known weakness for hierarchical summarization, see [ROADMAP](./ROADMAP.md)).

## Quickstart

```ts
import {
  runAgentWithTools,
  ToolRegistry,
  createInferenceClient,
} from 'thread-phase';

const tools = new ToolRegistry().register(
  {
    name: 'add',
    description: 'Add two integers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  async (args) => String((args.a as number) + (args.b as number)),
);

const result = await runAgentWithTools(
  {
    name: 'math',
    systemPrompt: 'Use the add tool. Reply with just the number.',
    model: 'qwen3.6-27b',
    tools: tools.definitions(),
    maxToolRounds: 5,
    maxTokens: 256,
  },
  [{ role: 'user', content: 'What is 17 + 25?' }],
  { client: createInferenceClient(), toolExecutor: tools },
);

result.text;               // "42"
result.finishReason;       // "stop" | "length" | "tool_calls" | ...
result.usage;              // { promptTokens, completionTokens, totalTokens }
result.executedToolCalls;  // [{ id, name: 'add', input: { a: 17, b: 25 } }]
```

## Architecture

Three primitives.

### `runAgentWithTools(config, messages, options) → AgentRunResult`

The streaming tool-use loop. Sends a chat-completions request with `stream: true`, accumulates content and tool-call deltas, dispatches tools through `options.toolExecutor`, loops until the model produces final text or hits `config.maxToolRounds`. Returns a structured result:

- `text` — final text output
- `finishReason` — `'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | 'error' | 'unknown'`. Branch on `'length'` to detect truncation.
- `usage` — `{ promptTokens, completionTokens, totalTokens }`, summed across rounds
- `executedToolCalls` — every tool call the model actually executed (id, name, parsed args)
- `activity` — string log of internal events

`options.signal` propagates an `AbortSignal` into the inference call. `options.onStreamEvent` receives `content_delta`, `tool_call_started`, `tool_call_complete`, and `round_complete` events as they arrive. `options.verifyResult` is a hook that runs once before returning — it can transform the result or throw to mark the run as failed; use it to validate the agent's claimed output against `executedToolCalls`.

### `Phase<TCtx>` + `runPipeline(phases, ctx)`

A `Phase` is an async generator that reads from a shared `ctx`, yields events, and writes outputs back to `ctx`. A pipeline is an array of phases run in order:

```ts
interface Phase<TCtx extends BasePipelineContext> {
  readonly name: string;
  run(ctx: TCtx): AsyncGenerator<PipelineEvent, void>;
}

for await (const event of runPipeline([phaseA, phaseB, phaseC], ctx)) {
  // each phase yields events; the orchestrator owns the terminal 'done' / 'error'
}
```

`requireCtx(ctx, key, phaseName)` is the loud-precondition helper — fails with the field name if a prerequisite phase didn't populate the field. Use it at the top of every phase that reads from ctx.

`ctx.stop = { reason }` halts the pipeline cleanly. Loops, conditional branches, and parallel sub-flows are composed in TypeScript rather than declared in a graph language; the [`patterns/`](./docs/patterns.md) module names the recurring shapes.

### `JobRunner` + `JobStore`

`JobRunner` wraps a pipeline run with a persistent event log (`JobStore`, sqlite-backed by default), live event emission for SSE consumers, and per-job cancellation:

```ts
const runner = new JobRunner(new SqliteJobStore('./jobs.db'));
const jobId = runner.create('my-pipeline', input);

// wire SIGTERM to runner.cancel so a stuck inference call exits cleanly
process.on('SIGTERM', () => runner.cancel(jobId, 'systemd timeout'));

await runner.run(jobId, [phaseA, phaseB], ctx);
// events persisted; consumers can replay via store.getEvents(jobId, afterId)
// or subscribe live via runner.on(`job:${jobId}`, ...)
```

`JobRunner.signalFor(jobId)` exposes the `AbortSignal` so phase code can wire it into individual `runAgentWithTools` calls — without that wiring, cancellation only halts between phases.

The interface is sync by design (sqlite hot path; fire-and-forget event writes). Async backends will land as an additive `JobStoreAsync` interface if/when needed; see [ROADMAP](./ROADMAP.md).

## Patterns

In `thread-phase/patterns`:

| Pattern | Shape |
|---|---|
| `boundedFanout` | N items, agent per item, capped concurrency, results in input order |
| `streamingBoundedFanout` | Same, yields per-item events as items finish |
| `parallelFanout` | Uncapped per-item parallel runs |
| `parallelPhases` | Several phases run concurrently as one composite |
| `intentGate` | Cheap classifier decides whether the rest of the pipeline runs |
| `preflightConfidence` | Score feasibility before spending big-model tokens |
| `synthesizeWithFollowup` | Synthesizer reviews its own output; may request another round |
| `spotCheck` | Verify a sample of typed claims |

See [`docs/patterns.md`](./docs/patterns.md) for selection guidance ("I want to do X" → "use Y").

## Configuration

Environment-driven by default (override in code via `loadInferenceConfig({ ... })`):

```bash
INFERENCE_BASE_URL=http://localhost:8000/v1
INFERENCE_API_KEY=not-needed-for-local-vllm
INFERENCE_MODEL=qwen3.6-27b
INFERENCE_CONTEXT_LENGTH=131072
```

For tool-using agents on vLLM, the server needs `--enable-auto-tool-choice --tool-call-parser <name>` matching the model's output format. If content shaped like a tool call arrives as plain text instead of structured `tool_calls`, the runner emits a `parser_mismatch_warning` activity entry.

## Examples

In [`examples/`](./examples), runnable via `npx tsx examples/<name>.ts`:

| File | Demonstrates |
|---|---|
| `bare-agent.ts` | Single tool, single agent call, structured result |
| `multi-phase-pipeline.ts` | Linear pipeline with one parallel branch |
| `streaming-consumer.ts` | Content + tool-call deltas as they stream |
| `bounded-fanout.ts` | Per-item agent over a list, concurrency-capped |
| `sse-server.ts` | `JobRunner` + `streamToSSE` in an HTTP handler |
| `agent-authored-cron.ts` | End-to-end automation skeleton — fetch / triage / summarize / compose, with `verifyResult` and `JobRunner` |

## Stability

v1.0.0 onward follows semver:

- **patch (1.0.x)** — bug fixes, no API changes
- **minor (1.x.0)** — additive changes (new patterns, new optional fields)
- **major (x.0.0)** — breaking changes

Items marked `@internal` in their JSDoc (e.g. `consumeStream`, `toOpenAIMessages`) are reachable for advanced callers but **not** covered by semver.

103 tests across 13 files. Validated in production by [`Code4me2/chiya-library`](https://github.com/Code4me2/chiya-library) — digest + librarian pipelines, hundreds of articles per day, on systemd timers.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). For larger changes, open an issue first — the framework has a deliberately narrow scope and we'd rather discuss before code is written.

## License

MIT. See [LICENSE](./LICENSE).
