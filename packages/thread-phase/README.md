# thread-phase

A TypeScript framework that composes deterministic phases over **heterogeneous agents** — the iterated tool-use loop against OpenAI-compatible inference for raw model calls, the `AgentAdapter` protocol for delegating to ready agents (Claude Code, Hermes, Codex, OpenClaw, Anthropic SDK). Multi-phase pipelines with a typed shared context, persistent event logs, cancellation, checkpoints, and concurrency-capped fanout.

The workflow structure is deterministic: phase order, bounds, branching, retries, and terminal-state behavior are encoded in TypeScript. Agent output inside a phase remains probabilistic. thread-phase is a bounded execution substrate, not a distributed DAG scheduler or product UI.

```bash
npm install @autonome-research/thread-phase
```

> **Generating thread-phase code with an LLM agent?** See [`AGENTS.md`](./AGENTS.md) — a self-contained reference covering the mental model, a copy-paste template, and explicit anti-patterns. Claude Code users can also install [`SKILL.md`](./SKILL.md) into `~/.claude/skills/thread-phase/` so the guidance auto-loads.

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
} from '@autonome-research/thread-phase';

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

Three primitives plus one extension surface.

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

`JobRunner` automatically composes its cancellation signal with any caller-provided signal and installs the result as `ctx.signal`. Phase code passes `ctx.signal` into `runAgentWithTools`, adapters, HTTP calls, or other abortable work. `runner.start(...)` returns an immediate run handle with `signal`, `cancel()`, and `result`; `signalFor(jobId)` remains available for existing integrations.

`JobStore` is asynchronous so SQLite, Postgres, Redis, and network-backed implementations share one consistency contract. The bundled `SqliteJobStore` uses Node's synchronous built-in `node:sqlite` hot path internally and exposes it through the same Promise-based interface. Node.js 22.5 or newer is required.

The v5.0.0 `JobStore` contract remains unchanged. The published contract already includes atomic owner-aware claiming and finalization, cancellation and abandonment transitions, owner-scoped heartbeat, and heartbeat enablement. Custom stores must implement that released interface. The provenance-backed declaration fixture under `test-d/fixtures/v5.0.0/` verifies the exact published shape.

With `heartbeatMs`, `JobRunner` schedules at most one automatic owner-scoped heartbeat at a time. `heartbeatTimeoutMs` requires and defaults to `heartbeatMs`; once configured, it bounds how long the runner waits for automatic attempts and manual `ctx.heartbeat()` calls. Manual-only runs cannot currently configure a timeout. Custom stores must still bound or cancel their own underlying I/O because the Promise-based `JobStore` contract has no abort parameter. Manual calls are caller-controlled and may overlap an automatic attempt. Ownership loss, timeout, or backend failure stops scheduling and fails the run without being misclassified as cancellation. Cancellation that was requested first—through either the caller signal or `runner.cancel()`—remains authoritative; otherwise the first pipeline or heartbeat failure wins. Bundled SQLite and updated custom stores use optional `refreshHeartbeat(jobId, ownerId)` for owner-observable repeated refresh, converting `false` into `JobOwnershipLostError`. Published-v5 stores instead use one-time `enableHeartbeat()` plus owner-scoped `heartbeat()` fallback; because v5 did not define repeated-enable boolean semantics and permitted mismatch no-ops, those legacy stores cannot always report ownership loss until upgraded. Unscoped refresh bypasses ownership checks; hosts should reserve `runner.heartbeatAsOperator(jobId)` for explicit recovery operations. The older `runner.heartbeat(jobId)` name remains as a deprecated compatibility alias.

### `AgentAdapter` — the extension surface

`AgentAdapter` is the protocol every ready-agent integration speaks. The in-tree `inferenceAgent` wraps `runAgentWithTools`; sibling implementations in [`@autonome-research/thread-phase-agents`](../thread-phase-agents) wrap `hermes`, `openclaw`, `claude`, the OpenAI Responses API (Codex), and the Anthropic SDK directly.

Every adapter returns the same shape:

```ts
interface AgentRun {
  readonly events: AsyncIterable<AgentEvent>;  // single-consumer stream
  readonly result: Promise<AgentRunResult>;     // always resolves, never rejects
  abort(reason?: string): void;
}
```

Canonical events: `agent_start | text | thinking | tool_call | tool_result | turn_end | agent_end | error | native`. Every event carries a `source` field (the adapter's id) so heterogeneous adapter events flow through one `AgentEventBus` without losing provenance.

`AgentEventBus.emit(event)` is synchronous and always returns `void`; it starts each subscriber in registration order without awaiting returned promises, so use the bus for observation rather than sequencing. A subscriber throw or rejection does not escape `emit` or stop healthy subscribers. The stable `AgentEventBus` contract remains emit/on-only so legacy implementations stay structurally compatible; `createEventBus()` returns the additive `ObservableAgentEventBus` subtype. Register `bus.onHandlerError(({ handler, event, error }) => ...)` on that factory-created bus to observe failures; non-`Error` values are normalized to `Error`. Error observers are also fire-and-forget, and their own failures are contained rather than recursively reported. Both `on` and `onHandlerError` return idempotent unsubscribe callbacks.

Adapter-event persistence has two deliberately different bridges:

```ts
import {
  createAgentEventPersistenceBridge,
  pipeAgentEventsToJobStore,
} from '@autonome-research/thread-phase/agents';

// Existing best-effort API: unchanged signature and unsubscribe return value.
// Appends are fire-and-forget; sync throws and rejected appends are swallowed.
const unsubscribe = pipeAgentEventsToJobStore(bus, store, jobId, {
  dropTypes: ['text'],
});

// Durable opt-in: finite ordered queue, deterministic drain, and failures.
const persistence = createAgentEventPersistenceBridge(bus, store, jobId, {
  capacity: 256,
  onFailure: ({ kind, event, error, occurrences }) =>
    logPersistenceFailure(kind, event, error, occurrences),
});
await persistence.flush(); // all events accepted before this call have settled
await persistence.close(); // unsubscribe and drain; safe to call repeatedly
```

Use `pipeAgentEventsToJobStore` only when best-effort telemetry is sufficient: it preserves the existing synchronous call shape but offers no delivery barrier or failure signal. Use `createAgentEventPersistenceBridge` when shutdown or terminal work must wait for accepted events. Its capacity counts queued and currently appending events; events emitted while full are rejected and reported as `overflow`, append failures are reported as `append`, and later accepted events continue draining in input order. Failure observers active or pending when `flush()` or `close()` is invoked are included in that barrier. Later failures cannot add another observer delivery to an existing barrier, though they may coalesce into the same already-required pending notification. Synchronous same-kind bursts are aggregated before delivery; if an asynchronous observer remains active, further failures of that kind are coalesced into at most one pending immutable notification. A notification already passed to an observer never changes, and repeated barriers never force concurrent same-kind observer calls. This keeps observer work finitely bounded even during an overflow storm while preserving stable `occurrences` values. Append and overflow failures use separate batches. Install `onFailure` when failures must be acted on.

Register generic asynchronous cleanup with `JobRunOptions.drains` when accepted work must settle before the job's terminal event and state are persisted:

```ts
await runner.run(jobId, phases, ctx, finalResult, {
  drains: [
    () => persistence.close(),
    () => outputWriter.flush(),
  ],
});
```

Drains run sequentially in registration order, and every drain is attempted, including when ownership acquisition returns false or rejects. They are callbacks rather than AgentEventBus-specific objects, so `JobRunner` remains independent of adapters and event delivery. A drain failure turns an otherwise successful run into `FAILED`. If pipeline or ownership-acquisition failure and drain failure coincide, the original failure remains primary; cancellation similarly takes precedence over drain failures. The rejected `AggregateError` exposes all accompanying drain failures, so cleanup loss is not silent. Terminal persistence and runner hook shutdown happen only after draining finishes.

Conversation state across phases lives in the `Thread` primitive — canonical events plus per-adapter resume tokens. Same-adapter chains (claude-code → claude-code) resume natively via the adapter's session; cross-adapter chains render events back to text via `threadToMessages`.

Memory across runs is outsourced: `MemoryProvider` is just a TypeScript interface (`recall(scope, query?) / remember(scope, events)`). thread-phase ships no implementations; bind Honcho, Letta, Mem0, or a custom backend yourself. See [`examples/honcho-memory.ts`](./examples/honcho-memory.ts).

### `Trigger` — the entry-point abstraction

`Trigger<TInput>` is the protocol every signal source implements: timers, webhooks, queue consumers, file watchers, message brokers. Each trigger yields `TriggerEvent<TInput>` with `{ id, occurredAt, input, metadata }`. `runTrigger(trigger, factory, options)` is the canonical consumer — it reads events, dispatches pipelines (optionally through a `JobRunner`), enforces a concurrency cap with backpressure, and isolates per-event failures.

Core ships two built-in triggers: `TimerTrigger` (interval-driven) and `CronTrigger` (cron-expression-driven, lazy-loaded). HTTP/queue/file-watch transports stay in `examples/triggers/` as recipes — wrap your favorite framework into the protocol, don't make thread-phase ship transports.

For most automation, reach for the higher-level helpers on the main index (`schedule`, `hook`, `oneShot`) — they construct the underlying trigger and wire it through `runTrigger` in one call. The lower-level API is below if you need it:

```ts
import { TimerTrigger, runTrigger } from '@autonome-research/thread-phase/triggers';

const trigger = new TimerTrigger({ intervalMs: 15 * 60_000, name: 'every-15m' });
const handle = runTrigger(
  trigger,
  () => ({ phases: [myPipeline], ctx: { cache: new PipelineCache() } }),
  { jobRunner: runner },
);

process.on('SIGTERM', () => void handle.stop());
await handle.done;
```

Equivalent with the helper (when you don't need the lower-level pieces):

```ts
import { schedule } from '@autonome-research/thread-phase';

export default schedule({ intervalMs: 15 * 60_000 }, async () => {
  await doStuff();
});
```

## Patterns

In `@autonome-research/thread-phase/patterns`:

| Pattern | Shape |
|---|---|
| `boundedFanout` | N items, free-function runner per item, capped concurrency, results in input order |
| `boundedFanoutOf` | Same, but the runner is an `AgentAdapter` + buildConfig — automatic event-bus propagation |
| `parallelPhases` | Several phases run concurrently as one composite |
| `intentGate` | Cheap classifier decides whether the rest of the pipeline runs |
| `whileCondition` | Loop a body of phases while an async predicate holds, with a max-iteration cap |
| `match` | Keyed dispatch — route to one of N phase lists by selector key |
| `withRetry` | Higher-order wrapper retrying a phase with exponential backoff on failure |

See [`docs/patterns.md`](./docs/patterns.md) for selection guidance ("I want to do X" → "use Y"). v3.0.0 trimmed five patterns (`parallelFanout`, `streamingBoundedFanout`, `preflightConfidence`, `synthesizeWithFollowup`, `spotCheck`) into composition recipes — see [`docs/recipes.md`](./docs/recipes.md) for paste-in equivalents.

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
| `honcho-memory.ts` | `MemoryProvider` bound to Honcho — recall before an agent call, remember after |

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
