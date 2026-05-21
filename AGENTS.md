# AGENTS.md — thread-phase

> **Audience:** LLM agents (Claude Code, Cursor, Codex, Cline, GitHub Copilot, etc.) generating TypeScript code that **uses** the thread-phase library. Not for agents working *on* this repo's source — that case should read `CONTRIBUTING.md`.
>
> **How to use:** Load this file as context when a user asks you to write a thread-phase automation, agent pipeline, or cron task. Refer back as needed. The reference card at the bottom gives you import lines you can copy.
>
> **Claude Code users:** this repo also ships [`SKILL.md`](./SKILL.md), a Claude-Code-flavored mirror of this content with the frontmatter Claude Code's skill system auto-loads from. Drop it into your skills dir so it triggers without manual context-loading:
> ```bash
> mkdir -p ~/.claude/skills/thread-phase
> cp SKILL.md ~/.claude/skills/thread-phase/SKILL.md
> ```
> The two files cover the same ground; `AGENTS.md` is the canonical source — `SKILL.md` is the same content with a different framing for Claude Code's trigger system.
>
> **If you're a human reading this:** the [README](./README.md) and [docs/patterns.md](./docs/patterns.md) are probably more useful — this doc is dense and assumes you can pattern-match on code.

---

## TL;DR

thread-phase composes deterministic phases over **heterogeneous agents**. Each phase reads typed context, runs one or more agent calls — via `runAgentWithTools` for raw OpenAI-compatible models, via `AgentAdapter` for ready agents (Claude Code, Hermes, Codex, OpenClaw, Anthropic SDK) — and writes typed context back. Pipelines are linear arrays of phases composed in TypeScript. Concurrency, retry, and cancellation are owned by `JobRunner`. Context flow between agent calls within a thread is handled by the `Thread` primitive. Memory across pipeline runs is outsourced to a `MemoryProvider` — thread-phase does not persist anything beyond the `JobStore` event log.

You are most often using thread-phase when:
- A task has 2+ steps that need to run in a specific order
- One or more steps involve calling an LLM (raw model or a ready agent), possibly with tools
- You want to mix heterogeneous agents in one pipeline (a cheap local model for triage, claude-code for implementation, codex for verification)
- The task is repeatable (cron / systemd / CI) and shouldn't re-derive its plan every run
- You want to verify the agent's claimed output before recording success
- You want event logs you can read back later to debug what happened

You are NOT using thread-phase when:
- The task is "ask the LLM one question and print the answer" — just call `runAgentWithTools` directly, no pipeline needed
- The task is a complex DAG with cross-edges — use Temporal/LangGraph/Inngest, embedding `runAgentWithTools` inside their nodes
- You need a per-user memory store as a built-in concept — thread-phase ships only the `MemoryProvider` interface; you wire in Honcho/Letta/Mem0 yourself

---

## The mental model

Three primitives plus one extension surface. Memorize these — everything else is composition.

```ts
// 1. A Phase is a typed unit of work. It reads from a shared ctx, yields
//    events, writes outputs back to ctx, and returns when done.
interface Phase<TCtx extends BasePipelineContext> {
  readonly name: string;
  run(ctx: TCtx): AsyncGenerator<PipelineEvent, void>;
}

// 2. runPipeline runs an array of phases in order over a shared ctx.
//    No DAG framework — the array IS the pipeline.
async function* runPipeline<TCtx>(phases: Phase<TCtx>[], ctx: TCtx): AsyncGenerator<PipelineEvent>;

// 3. runAgentWithTools is the streaming tool-use loop against an OpenAI-
//    compatible inference endpoint. Calls happen inside phases (or
//    directly, if you don't need a pipeline).
async function runAgentWithTools(
  config: AgentConfig,
  messages: Message[],
  options: AgentRunnerOptions,
): Promise<AgentRunResult>;

// 4. AgentAdapter is the protocol every "ready agent" satisfies. Use the
//    in-tree inferenceAgent for OpenAI-compatible inference (wraps #3) or
//    a sibling adapter (hermes, openclaw, anthropic, codex, claude-code)
//    when you want to delegate to a pre-built agent.
type AgentAdapter<TConfig> = (
  config: TConfig,
  options?: AgentRunOptions,
) => AgentRun;
```

Composition rule: **mutate `ctx` for results, `yield` for progress events.** Never return data from `run` — write it to ctx and read it back in a downstream phase via `requireCtx`.

When to reach for `runAgentWithTools` vs an `AgentAdapter`:

- **`runAgentWithTools`** — a single raw model call inside a phase, you write the system prompt and tools. The canonical primitive; ~5 lines of setup. This is the right call for ~80% of cases.
- **`AgentAdapter`** — you're delegating to a *ready agent* (claude-code, hermes, codex, …) that has its own system prompt, tool set, and turn behavior, OR you want adapter-shaped composition (one shared event bus across heterogeneous adapters, `boundedFanoutOf` over a list, `Thread`-based handoff). Adapters live in `thread-phase` (`inferenceAgent`) and the sibling package [`thread-phase-agents`](https://github.com/autonome-research/thread-phase-agents).

---

## The canonical template (copy this, then modify)

When asked to write a thread-phase automation, start from this skeleton. It's the shape that handles ~80% of cases.

```ts
import {
  PipelineCache,
  JobRunner,
  SqliteJobStore,
  createInferenceClient,
  loadInferenceConfig,
  parseJSON,
  requireCtx,
  runAgentWithTools,
  type AgentRunnerOptions,
  type BasePipelineContext,
  type Phase,
  type ToolExecutor,
} from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';

// 1. Type your context. EVERY field a phase produces should be optional
//    here (it's not set until that phase runs) and read with requireCtx.
interface Ctx extends BasePipelineContext {
  fetched?: Item[];
  results?: Result[];
  output?: string;
}

// 2. Set up clients/executors once. noTools is fine if no agent in your
//    pipeline needs to call tools.
const config = loadInferenceConfig();
const client = createInferenceClient();
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

// 3. Define each phase. Use requireCtx for every input so a missing
//    upstream phase fails loud rather than silently passing undefined.
const fetchPhase: Phase<Ctx> = {
  name: 'fetch',
  async *run(ctx) {
    yield { type: 'phase', phase: 'fetch', detail: 'starting' };
    ctx.fetched = await fetchSomething();
    yield { type: 'data', key: 'fetched', value: { count: ctx.fetched.length } };
  },
};

const processPhase: Phase<Ctx> = {
  name: 'process',
  async *run(ctx) {
    const items = requireCtx(ctx, 'fetched', 'process');
    yield { type: 'phase', phase: 'process', detail: `processing ${items.length}` };

    ctx.results = await boundedFanout({
      items,
      concurrency: 3, // match your inference backend's --max-num-seqs
      runner: async (item) => {
        const r = await runAgentWithTools(
          {
            name: 'processor',
            systemPrompt: 'Process the input. Reply ONLY as JSON: {"result": "..."}',
            model: config.defaultModel,
            tools: [],
            maxToolRounds: 1,
            maxTokens: 300,
          },
          [{ role: 'user', content: serialize(item) }],
          {
            client,
            toolExecutor: noTools,
            cache: ctx.cache,
            // ALWAYS check finishReason before trusting parseJSON.
            verifyResult: (result) => {
              if (result.finishReason === 'length') {
                throw new Error('processor output truncated');
              }
              return result;
            },
          } satisfies AgentRunnerOptions,
        );
        return parseJSON<Result>(r.text, defaultResult());
      },
    });
  },
};

// 4. Top-level entry point. Use JobRunner so you get a persistent event
//    log and can wire SIGINT/SIGTERM to runner.cancel.
const dbPath = process.env.JOBS_DB ?? './jobs.db';
const store = new SqliteJobStore(dbPath);
const runner = new JobRunner(store);

const jobId = runner.create('my-automation', { startedAt: new Date().toISOString() });
const ctx: Ctx = { cache: new PipelineCache() };

const onSignal = () => runner.cancel(jobId, 'systemd timeout / SIGTERM');
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

await runner.run(jobId, [fetchPhase, processPhase], ctx, () => ({
  count: ctx.results?.length ?? 0,
}));

const job = store.getJob(jobId)!;
if (job.status === 'FAILED') {
  console.error('failed:', job.error);
  process.exit(1);
}

store.close();
```

That's the shape. Stretch it for more phases; remove `boundedFanout` if you only have one item; remove the JobRunner wrapper if you don't need persistence.

---

## When to reach for which pattern

```ts
import { /* one of these */ } from 'thread-phase/patterns';
```

| You have... | Use |
|---|---|
| N items, want to run a raw-model agent on each, capped concurrency | `boundedFanout` (use `onItemDone` for streaming progress) |
| N items, want to run an `AgentAdapter` on each (claude-code, hermes, etc.) | `boundedFanoutOf` |
| ≤2 items where concurrency-capping is overhead | just `Promise.all` |
| Two distinct phases that should run concurrently as one composite | `parallelPhases` |
| Cheap classifier that decides whether the rest of the pipeline runs | `intentGate` |
| Loop a body of phases until a predicate holds | `whileCondition` |
| Route to one of N phase lists by a key | `match` |
| Retry a flaky phase with exponential backoff | `withRetry` |
| Compose one pipeline as a step inside another | `subPipeline` (or `subPipelineOf` for inferred types) |

If none fit, write a `Phase` directly. Patterns are convenience, not requirement.

**Removed in v3.0.0:** `parallelFanout`, `streamingBoundedFanout`, `preflightConfidence`, `synthesizeWithFollowup`, `spotCheck` — see [`docs/recipes.md`](packages/thread-phase/docs/recipes.md) for paste-in equivalents.

### `boundedFanoutOf` — the adapter-driven sibling of `boundedFanout`

Use when each item should run through an `AgentAdapter` (claude-code, hermes, codex, anthropic, …) rather than a free-function runner. Headline differences vs `boundedFanout`:

- Wires `options.eventBus` automatically so events from every parallel adapter run land on one bus
- `options.signal` propagates into every adapter call via `AbortSignal.any`
- Result type is `AgentRunResult[]` in input order (not the caller's free choice)

```ts
import { boundedFanoutOf } from 'thread-phase/patterns';
import { claudeCodeAgent } from 'thread-phase-agents';

const results = await boundedFanoutOf({
  items: filesToReview,
  concurrency: 3,
  adapter: claudeCodeAgent,
  buildConfig: (file) => ({ cwd: '/repo', prompt: `Review ${file}` }),
  signal: ctx.signal,
  eventBus: ctx.bus,    // every parallel run's events land here
  mode: 'collect',
});
```

Reach for plain `boundedFanout` when you control the runner directly (an HTTP call, a `runAgentWithTools` invocation with custom verification, etc.) — the callback form is more direct.

---

## Agent-result handling — the rules

These are non-negotiable. Following them prevents 80% of the bugs that come up in agent-authored automations.

### Rule 1: Always check `finishReason` before trusting `parseJSON`

```ts
const r = await runAgentWithTools(config, messages, options);
if (r.finishReason === 'length') {
  // Output was truncated. parseJSON's fallback is meaningless here.
  throw new Error('agent output truncated; cannot proceed');
}
const parsed = parseJSON<MyShape>(r.text, fallback);
```

`finishReason: 'length'` means the model hit `maxTokens` and the JSON is almost certainly cut off mid-field. `parseJSON` will warn and return the fallback, which silently masks the truncation. Reading `finishReason` is the only reliable signal.

### Rule 2: Use `verifyResult` whenever the agent claims to have done something it should have proved with a tool call

```ts
verifyResult: (result) => {
  // Did the agent claim "I created the file" without actually calling write_file?
  const calledWrite = result.executedToolCalls.some((tc) => tc.name === 'write_file');
  if (claimedWrite(result.text) && !calledWrite) {
    throw new Error('agent claimed to write but never called write_file');
  }
  return result;
}
```

Small models confabulate. They'll say "I created the page" with confidence, never having called the tool. `executedToolCalls` is the ground truth. This is the canonical defense.

### Rule 3: Wire SIGINT/SIGTERM to `runner.cancel(jobId)`

```ts
const onSignal = () => runner.cancel(jobId, 'SIGTERM received');
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
```

Without this, a stuck inference call survives systemd's `TimeoutStartSec` — the timer marks the unit failed but your child process keeps running. Wiring cancel propagates the abort into the inference call so the process exits cleanly.

### Rule 4: Keep `maxTokens` and `maxToolRounds` realistic for your phase

Phases that produce JSON: 200-500 maxTokens is plenty. Anything more is wasted budget and slows the run.

Phases that compose long-form text: 600-2000 maxTokens. If you set it lower and your output gets truncated, `finishReason: 'length'` is your fault, not the model's.

`maxToolRounds`: 1 for non-tool agents. 3-5 for normal tool-use loops. Higher only if you're doing multi-step tool chains intentionally.

### Rule 5: Use `parseJSON` with a sensible fallback, never `JSON.parse` directly

```ts
const decision = parseJSON<{ keep: boolean }>(text, { keep: false });
```

`parseJSON` strips markdown code fences, falls back to extracting the first `{...}` from prose, and returns the fallback on failure. `JSON.parse(r.text)` will throw on the first ` ```json` fence the model emits, which is almost every model.

---

## Anti-patterns — DO NOT do these

### ❌ Returning data from a `Phase.run`'s generator

```ts
// WRONG
async *run(ctx) {
  return { result: 42 }; // generator returns are ignored by runPipeline
}

// RIGHT
async *run(ctx) {
  ctx.result = 42;
}
```

### ❌ Reading `ctx.foo` directly without `requireCtx`

```ts
// WRONG — silently passes undefined if upstream didn't run
const items = ctx.fetched;
for (const item of items) { ... }

// RIGHT — fails loud with phase name and field name
const items = requireCtx(ctx, 'fetched', 'process');
```

### ❌ Trusting agent text without checking `finishReason`

```ts
// WRONG
const data = parseJSON<MyShape>(r.text, defaults);
ctx.data = data;

// RIGHT
if (r.finishReason === 'length') throw new Error('truncated');
const data = parseJSON<MyShape>(r.text, defaults);
ctx.data = data;
```

### ❌ Running an agent that calls tools without a real `ToolExecutor`

```ts
// WRONG — agent will call tools, get empty responses, and confabulate
runAgentWithTools(configWithTools, msgs, { client, toolExecutor: noToolsExecutor });

// RIGHT — register the tools the agent's prompt promises it can call
const tools = new ToolRegistry().register(toolDef, async (args) => realImpl(args));
runAgentWithTools({ ...config, tools: tools.definitions() }, msgs, {
  client,
  toolExecutor: tools,
});
```

### ❌ Setting concurrency higher than your inference backend supports

```ts
// WRONG if vLLM's --max-num-seqs is 4
boundedFanout({ items: many, concurrency: 50, runner });
// All 50 queue up; you get no extra throughput, just head-of-line blocking

// RIGHT — match the backend's actual concurrency cap
boundedFanout({ items: many, concurrency: 4, runner });
```

### ❌ Putting `parallelPhases` inside `parallelPhases` repeatedly

```ts
// If you find yourself doing this, your pipeline is graph-shaped.
// Don't keep nesting — switch to Temporal/LangGraph/Inngest for orchestration
// and use thread-phase only for the agent loops inside each node.
parallelPhases('outer', [
  parallelPhases('inner1', [...]),
  parallelPhases('inner2', [...]),
]);
```

### ❌ Storing an agent's text output without the structured fields

```ts
// WRONG — loses finishReason, usage, and executedToolCalls
ctx.result = (await runAgentWithTools(...)).text;

// RIGHT — keep the full result if you might need to verify later
const r = await runAgentWithTools(...);
ctx.result = { text: r.text, tokensUsed: r.usage.totalTokens, tools: r.executedToolCalls };
```

---

## Configuration the agent should ask the user about

When you (the agent) are writing a thread-phase automation for a human, these are the configuration values you should *not* invent — ask the human, or pick a reasonable default and call it out so they can change it:

- **Inference endpoint** — `INFERENCE_BASE_URL`. Default `http://localhost:8000/v1`. Common alternatives: `http://localhost:11434/v1` (Ollama), `https://api.openai.com/v1` (OpenAI).
- **Model name** — `INFERENCE_MODEL`. No safe default; the human knows what's on their endpoint.
- **Concurrency cap** — should match the backend's `--max-num-seqs` (vLLM) or equivalent. Default 3-4 if unspecified.
- **Schedule** — when the cron entry runs. Match the user's stated cadence; don't pick on their behalf.
- **Output destination** — print to stdout, append to a file, send via email, write to a vault. The pipeline's `compose` phase (or equivalent) writes to `ctx.output`; the entry point reads it and dispatches.

---

## Using `AgentAdapter` from a phase

```ts
import {
  inferenceAgent,
  createEventBus,
  type AgentEvent,
  type AgentRun,
} from 'thread-phase/agents';

const bus = createEventBus();
const observed: AgentEvent[] = [];
bus.on((event) => observed.push(event));   // or pipe to JobStore, SSE, etc.

const run: AgentRun = inferenceAgent.adapter(
  {
    config: { name: 'classifier', systemPrompt: '...', model: '...', tools: [], maxToolRounds: 1, maxTokens: 200 },
    messages: [{ role: 'user', content: '...' }],
    runnerOptions: { client, toolExecutor: noTools },
    outputSchema: { schema: '{"relevant":boolean}' },  // optional prompted-output
  },
  { signal: ctx.signal, eventBus: bus },
);

const result = await run.result;  // never rejects; finishReason encodes the outcome
if (result.parsed) ctx.relevant = (result.parsed as { relevant: boolean }).relevant;
if (result.parseError) /* parse failed — caller decides whether to retry */
```

For sibling adapters (`hermesAgent`, `claudeCodeAgent`, `codexAgent`, etc.), the config shape is adapter-specific but the resulting `AgentRun` is identical — same `events` iterable, same `result` promise, same `abort()` method. Iterate events for streaming UX; await result for final text + tool calls + resume token.

**Cross-adapter Thread handoff:** use the `Thread` primitive to flow conversation state across phases:

```ts
import { createThread, appendEvent, resumeTokenFor, threadToMessages } from 'thread-phase/agents';

const thread = ctx.thread ?? createThread();

// In phase A — capture events:
for await (const event of runA.events) {
  appendEvent(thread, event);
}
ctx.thread = thread;

// In phase B with the same adapter — adapter resumes natively:
const runB = claudeCodeAgent.adapter({
  cwd, prompt: 'continue',
  resumeSessionId: resumeTokenFor(thread, 'claude-code')?.data,
});

// In phase B with a different adapter — render history to messages:
const history = threadToMessages(thread);
const runC = anthropicAgent.adapter({ model: '...', messages: [...history, /* new user turn */] });
```

## Memory across pipeline runs

`thread-phase` ships only the `MemoryProvider` interface — it does not bundle Honcho, Letta, Mem0, or any other backend.

```ts
import type { MemoryProvider, MemoryScope } from 'thread-phase/agents';

const provider: MemoryProvider = {
  async recall(scope, query) { /* return prompt-ready string */ return ''; },
  async remember(scope, events) { /* persist this run's events */ },
};
```

Pass via `AgentRunOptions.memoryProvider` and wrap the adapter with `withMemory` to plumb both ends automatically:

```ts
import { withMemory, inferenceAgent } from 'thread-phase/agents';

const memoryAware = withMemory(inferenceAgent, {
  scope: { userId: ctx.userId },
  inject: (cfg, memory) => ({
    ...cfg,
    config: {
      ...cfg.config,
      systemPrompt: `${cfg.config.systemPrompt}\n\nContext about the user:\n${memory}`,
    },
  }),
  query: (cfg) => cfg.messages[cfg.messages.length - 1]?.content?.toString(),
});

const run = memoryAware.adapter(cfg, { memoryProvider: provider });
// recall happens before the run starts; remember happens after agent_end
// before run.result resolves. Recall/remember failures surface as
// native events on the bus; the run never fails because of memory.
```

`withMemory` is a no-op when `options.memoryProvider` is absent — decorate once at module load, decide per-call whether memory applies. See `examples/honcho-memory.ts` for a complete Honcho binding.

## Threading state across phases

`Thread` is the conversational primitive that flows between phases. `withThread` makes adapters auto-consume it — no glue code required:

```ts
import { withThread, createThread, claudeCodeAgent } from 'thread-phase/agents';

const thread = createThread();

const adapter = withThread(claudeCodeAgent, thread, {
  applyResume: (cfg, token) => ({
    ...cfg,
    resumeSessionId: token.kind === 'opaque' ? token.data : undefined,
  }),
});

// First phase — creates a session, fills thread.events, captures the session id.
await adapter.adapter({ cwd, prompt: 'analyze this codebase' }).result;

// Second phase — same thread; adapter reads thread.resumeTokens['claude-code']
// and adds --resume <id> automatically. Events accumulate in thread.events.
await adapter.adapter({ cwd, prompt: 'now refactor the file you mentioned' }).result;
```

`withThread` is appropriate for any adapter; the per-adapter `applyResume` callback knows which config field holds the resume token (`resumeSessionId` for ACP/Claude Code, `previousResponseId` for Codex, etc.). Anthropic has no resumption — omit `applyResume`; events still mirror into the thread.

## Mid-stream follow-up with steerable runs

ACP-based adapters (`hermesAgent`, `openClawAgent`, the chassis `acpAgent`) return `SteerableAgentRun` at runtime. Use `isSteerable` to narrow safely:

```ts
import { isSteerable } from 'thread-phase/agents';
import { hermesAgent } from 'thread-phase-agents';

const run = hermesAgent.adapter({ cwd, prompt: 'do the first thing' });

// Queue additional prompts on the same ACP session.
if (isSteerable(run)) {
  await run.followUp('also do the second thing');
  await run.followUp('then summarize');
}

// The run sends each as a separate session/prompt; events stream in order
// with a turn_end between each. result resolves with the LAST turn's
// finishReason.
const result = await run.result;
```

`steer()` is on the protocol surface but ACP-based adapters reject — ACP's `session/prompt` is discrete, no mid-generation injection. `followUp` is the supported pattern.

## Reference card — public API

Stable surface (covered by semver from v1.0.0):

```ts
// Phase framework
import {
  PipelineCache,
  runPipeline,
  requireCtx,
  type Phase,
  type BasePipelineContext,
  type PipelineEvent,
} from 'thread-phase';

// Internal Message shape (closer to OpenAI than Anthropic)
import {
  type Message,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolExecutor,
} from 'thread-phase';

// Inference helpers
import {
  loadInferenceConfig,
  createInferenceClient,
  type InferenceConfig,
} from 'thread-phase';

// Agent runner — the iterated tool-use loop
import {
  runAgentWithTools,
  parseJSON,
  type AgentConfig,
  type AgentRunnerOptions,
  type AgentRunResult,
  type AgentStreamEvent,
  type FinishReason,
  type UsageInfo,
} from 'thread-phase';

// Persistence + live streaming
import {
  type JobStore,
  SqliteJobStore,
  JobRunner,
  type JobRecord,
  type LiveEvent,
  streamToSSE,
  type SSEResponse,
} from 'thread-phase';

// Tool registry with ajv arg validation
import {
  ToolRegistry,
  type ToolHandler,
} from 'thread-phase';

// Patterns (separate subpath)
import {
  boundedFanout,
  boundedFanoutOf,
  parallelPhases,
  intentGate,
  whileCondition,
  match,
  withRetry,
  subPipeline,
  subPipelineOf,
} from 'thread-phase/patterns';

// AgentAdapter protocol + helpers (separate subpath)
import {
  defineAgentAdapter,
  inferenceAgent,
  createThread,
  appendEvent,
  resumeTokenFor,
  setResumeToken,
  threadToMessages,
  createEventBus,
  composeAbort,
  createEventQueue,
  lazyEvents,
  TurnAccumulator,
  parseStructured,
  parseStructuredFromText,
  applyStructuredOutputPrompt,
  requireCapability,
  AgentCapabilityError,
  StructuredOutputParseError,
  serializeError,
  // Adapter decorators (v1.3.x+):
  withMemory,
  withThread,
  isSteerable,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentEvent,
  type AgentEventBus,
  type AgentCapabilities,
  type AgentAdapter,
  type AgentAdapterMeta,
  type SteerableAgentRun,
  type Thread,
  type ResumeToken,
  type SerializableError,
  type MemoryProvider,
  type MemoryScope,
  type StructuredOutputConfig,
  type InferenceAgentConfig,
  type WithMemoryOptions,
  type WithThreadOptions,
} from 'thread-phase/agents';

// Adapter conformance suite for test files (separate subpath)
import {
  createMockAgent,
  runAdapterConformance,
  type MockAgentConfig,
} from 'thread-phase/agents/test-utils';

// Sibling adapter implementations (separate package)
import {
  acpAgent,
  hermesAgent,
  openClawAgent,
  anthropicAgent,
  codexAgent,
  claudeCodeAgent,
} from 'thread-phase-agents';
```

Items marked `@internal` in their JSDoc (e.g. `consumeStream`, `toOpenAIMessages`) are reachable for advanced cases but not covered by semver. Do not generate code that depends on them unless the user explicitly asks for low-level access.

---

## When in doubt

- Read [`docs/patterns.md`](./docs/patterns.md) for the pattern selection table.
- Read [`examples/agent-authored-cron.ts`](./examples/agent-authored-cron.ts) for the canonical end-to-end shape of an agent-authored automation.
- Read [`examples/bare-agent.ts`](./examples/bare-agent.ts) for the smallest useful single-agent call.
- Read [`README.md`](./README.md) for the human-facing pitch.
- Read [`ROADMAP.md`](./ROADMAP.md) before suggesting features that aren't there — they may be deliberately out of scope.

If your generated code typechecks (`npm run typecheck`) and the user can run it (`npx tsx my-pipeline.ts`), you've done your job. The framework is intentionally small enough that "follow the canonical template" is the right answer 90% of the time.
