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

## Quickstart — convenience helpers (read this first)

**Default to these helpers for any simple automation.** Reach for the full Phase template (further down) only when the user genuinely needs typed phase composition, multiple steps with shared `ctx`, or `runAgentWithTools` inside a phase.

Install once:

```sh
npm install -g @autonome-research/thread-phase-cli
# …plus the agent SDKs your adapters use (optional; only when you import them):
# npm install -g @anthropic-ai/sdk @earendil-works/pi-coding-agent openai
# piAgent's @earendil-works/pi-coding-agent SDK requires Node.js >=22.19.0.
```

Each helper returns the default export of a `.thread-phase/pipelines/<name>.ts` file. Drop the file in, then `thread-phase run <name>` or `thread-phase serve`.

### One-shot — run on demand

```ts
// .thread-phase/pipelines/digest.ts
import { oneShot } from '@autonome-research/thread-phase';

export default oneShot(async () => {
  const items = await fetchInbox();
  const summary = await summarize(items);
  await sendEmail(summary);
});
```

Run: `thread-phase run digest`. Use this for ad-hoc scripts and anything a cron line invokes directly.

### Scheduled — cron- or interval-driven

```ts
// .thread-phase/pipelines/morning-digest.ts
import { schedule } from '@autonome-research/thread-phase';

export default schedule({ cron: '0 8 * * *' }, async () => {
  // body runs at 8am every day
});

// or
export default schedule({ intervalMs: 6 * 60 * 60 * 1000 }, async () => {
  // every 6 hours
});
```

Run: `thread-phase serve` starts the scheduler and keeps running until SIGINT/SIGTERM. `cron` form lazy-loads `cron-parser`; `intervalMs` form has zero extra deps.

### Webhook — HTTP-triggered

```ts
// .thread-phase/pipelines/webhook-digest.ts
import { hook } from '@autonome-research/thread-phase';

export default hook({ path: '/digest' }, async (payload, ctx) => {
  await processWebhook(payload);
  return { ok: true };  // becomes the HTTP 200 response body
});
```

Run: `thread-phase serve`. All hooks share one HTTP server (port from `THREAD_PHASE_HTTP_PORT`, default 7777). Each hook is one route.

### Decision rule

```
User asks for                                  → Reach for
─────────────────────────────────────────────────────────────────
"Run X on a schedule"                          → schedule({ cron|intervalMs }, …)
"Build a webhook that does X"                  → hook({ path }, …)
"Run this script via thread-phase"             → oneShot(…)
"Pipeline with 2+ phases sharing typed ctx"    → registerPipeline with Phase template
"Heterogeneous agent chain with Thread state"  → registerPipeline with Phase template
"Loop until convergence"                       → registerPipeline + whileCondition
"Fan an adapter over N items"                  → registerPipeline + boundedFanoutOf
```

The helpers cover the **first three rows** with one function call. The rest of this doc covers the bottom four cases.

---

## Where does X live? Import-path map

The substrate ships across three packages + a few subpaths. This table is the **single source of truth** for which symbol comes from where. When an import fails, check here first.

| You want… | Import from |
|---|---|
| **Building pipelines**: `Phase`, `runPipeline`, `runPipelineToSummary`, `PipelineCache`, `requireCtx`, `BasePipelineContext`, `PipelineEvent` | `@autonome-research/thread-phase` |
| **First-use helpers**: `oneShot`, `schedule`, `hook`, `CronTrigger`, `HttpTrigger` | `@autonome-research/thread-phase` |
| **Persistence**: `JobRunner`, `SqliteJobStore`, `JobStore`, `JobRecord` | `@autonome-research/thread-phase` |
| **Raw inference loop**: `runAgentWithTools`, `loadInferenceConfig`, `createInferenceClient`, `ToolRegistry` | `@autonome-research/thread-phase` |
| **Triggers**: `TimerTrigger`, `Trigger`, `TriggerEvent`, `runTrigger`, `RunTriggerHandle` | `@autonome-research/thread-phase/triggers` |
| **Patterns**: `whileCondition`, `match`, `withRetry`, `subPipeline`, `subPipelineOf`, `runSubPipeline`, `boundedFanout`, `boundedFanoutOf`, `parallelPhases`, `intentGate` | `@autonome-research/thread-phase/patterns` |
| **Pre-built agents**: `claudeCodeAgent`, `codexAgent`, `codexCliAgent`, `hermesAgent`, `openClawAgent`, `anthropicAgent`, `piAgent`, `grokBotAgent`, `acpAgent` | `@autonome-research/thread-phase-agents` |
| **Chain-builder utilities**: `createEventBus`, `pipeAgentEventsToJobStore`, `createThread`, `appendEvent`, `withMemory`, `withThread`, `isSteerable` | `@autonome-research/thread-phase-agents` (re-exported from core) |
| **Adapter-consumer types**: `AgentEvent`, `AgentRun`, `AgentRunResult`, `AgentEventBus`, `Thread`, `AgentAdapterMeta`, `AgentCapabilities` | `@autonome-research/thread-phase-agents` (re-exported from core) |
| **Cross-adapter rendering** (when chaining different adapters): `threadToTranscript`, `threadToMessages`, `threadToAcpPrompt`, `threadToClaudeCodePrompt`, `threadToCodexInput`, `threadToAnthropicMessages` | `@autonome-research/thread-phase-agents` |
| **Authoring a custom AgentAdapter** — consumer-stable bits (`defineAgentAdapter`, protocol types) | `@autonome-research/thread-phase/agents` |
| **Authoring a custom AgentAdapter** — author-unstable helpers (`TurnAccumulator`, `composeAbort`, `createEventQueue`, `lazyEvents`, `applyStructuredOutputPrompt`, `parseStructuredFromText`, `requireCapability`, `serializeError`, `superviseChild`) | `@autonome-research/thread-phase/agents/authoring` |
| **Checkpoint / resume** (v4.1.0+): `completedCheckpointsFromEvents`, `Phase.checkpointKey`, `RunPipelineOptions.resume` | `@autonome-research/thread-phase` |
| **Pi extensions / CLI extension authoring**: `ThreadPhaseAPI`, `PipelineSpec`, `ExtensionRegisterFn` | `@autonome-research/thread-phase` (re-exported from helpers) |

**Two rules of thumb that cover 95% of cases:**

1. **Building a pipeline / cron / webhook?** → `@autonome-research/thread-phase`
2. **Using or chaining pre-built agents?** → `@autonome-research/thread-phase-agents` (single import for adapter + event bus + Thread + types)

The `/agents` subpath of core is only needed if you're authoring a **new** AgentAdapter from scratch — a small audience.

### Common deps for phase code

Phase bodies are plain TypeScript — they can import anything. Install per-pipeline as needed:

| Need | Common dep | Note |
|---|---|---|
| Run a shell command | `execa` | Cleaner than `child_process.spawn`; handles exit codes + stdout/stderr |
| File I/O | `node:fs` / `node:fs/promises` | Built-in |
| HTTP fetch | `fetch` (built-in Node 22+) or `node-fetch` | — |
| Database | `better-sqlite3`, `pg`, `mysql2`, etc. | Same as anywhere else in Node |
| Cron parsing (when not using `schedule({ cron })`) | `cron-parser` | Optional peer dep of thread-phase; lazy-loaded |

**Gotcha — `execa` on non-zero exit codes:** v9 throws when the underlying process exits non-zero. `git diff` exits 1 when there ARE changes (semantically success), which surprises naive code. Either catch the error and read `err.stdout`, or pass `{ reject: false }` to execa.

---

## Building multi-phase pipelines

When the user needs typed state shared across multiple steps, reach for the `Phase` model. Each phase reads from a typed `ctx`, mutates it for outputs, and yields events. Pipelines compose as plain arrays — no DAG framework, no plugin system.

```ts
import { runPipeline, PipelineCache, requireCtx } from '@autonome-research/thread-phase';
import type { Phase, BasePipelineContext } from '@autonome-research/thread-phase';

interface Ctx extends BasePipelineContext {
  items?: Item[];
  digest?: string;
}

const fetch: Phase<Ctx> = {
  name: 'fetch',
  async *run(ctx) {
    ctx.items = await fetchItems();
    yield { type: 'data', key: 'count', value: ctx.items.length };
  },
};

const summarize: Phase<Ctx> = {
  name: 'summarize',
  async *run(ctx) {
    const items = requireCtx(ctx, 'items', 'summarize');  // loud failure if not set
    ctx.digest = await summarizeItems(items);
    yield { type: 'data', key: 'digest', value: ctx.digest };
  },
};

const ctx: Ctx = { cache: new PipelineCache() };
for await (const event of runPipeline([fetch, summarize], ctx)) {
  console.log(event);
}
```

**Rules of the model:**

- **Mutate `ctx` for results, `yield` events for progress.** Never return data from `run`; downstream phases read it from ctx.
- **Use `requireCtx(ctx, 'field', phaseName)` for every input field.** Fails loud with the field name if a prerequisite phase didn't populate it. Catches phase-ordering bugs at the right layer.
- **Type every field as optional in `Ctx`.** Not set until that phase runs. `requireCtx` does the runtime check + narrowing.
- **No DAG framework.** The array IS the pipeline. Reorder by reordering the array.
- **One phase fails → pipeline halts.** Set `ctx.stop = { reason }` to halt cleanly between phases, or throw to propagate as a hard error.

To make this discoverable via the CLI, wrap in a `.thread-phase/pipelines/<name>.ts` extension file with `registerPipeline`. See [`EXTENDING.md`](./EXTENDING.md).

## Injecting code between stages

Adding a new step to an existing pipeline is **insertion into the array**. There's no plugin system to navigate — just edit the list of phases:

```ts
// Before
const phases = [fetch, summarize, send];

// Want to validate the digest before sending?
const validate: Phase<Ctx> = {
  name: 'validate',
  async *run(ctx) {
    const digest = requireCtx(ctx, 'digest', 'validate');
    if (digest.length < 50) ctx.stop = { reason: 'digest too short, skipping send' };
  },
};

// After
const phases = [fetch, summarize, validate, send];
```

Patterns for the less-trivial cases:

| You want to... | Reach for |
|---|---|
| Add a step that runs only when a condition holds | `match(name, { selector, cases, default? })` — routes to one of N phase lists |
| Add a step that may halt the pipeline cheaply | `intentGate` — classifier + short-circuit; sets `ctx.stop` if the heavy path isn't needed |
| Run two distinct phases concurrently as one composite | `parallelPhases(name, [a, b])` — the one DAG shape arrays can't express |
| Wrap a step with retry-on-failure | `withRetry(phase, { maxAttempts, baseDelayMs })` |
| Invoke another whole pipeline as a step (with isolated cache, propagated signal) | `subPipeline(name, { pipeline, mapInput?, mapOutput? })` |
| Add cross-cutting behavior to every phase (logging, metrics) | Higher-order function that takes a `Phase` and returns a wrapped `Phase` |

All of the above are themselves `Phase`s — they slot into the array like any other step.

**Sharing state between phases** is just ctx mutation:

```ts
const phaseA: Phase<Ctx> = { name: 'a', async *run(ctx) { ctx.x = 42; } };
const phaseB: Phase<Ctx> = { name: 'b', async *run(ctx) {
  const x = requireCtx(ctx, 'x', 'b');  // 42 — written by phaseA
  ctx.y = x * 2;
}};
```

For state that must NOT leak between phases (cache, scratch buffers): use the per-pipeline `PipelineCache` accessed via `ctx.cache` — it's cleared at pipeline end.

## Implementing loops

Three patterns by increasing complexity. Pick the lightest that fits the case.

### 1. Plain `while` inside a helper handler

When the loop is entirely inside one handler — no need for framework-level per-iteration events or JobStore log per iteration — just use plain JS:

```ts
import { oneShot } from '@autonome-research/thread-phase';

export default oneShot(async (ctx) => {
  let sources: string[] = [];
  while (sources.length < 6) {
    const more = await search();
    sources.push(...more);
  }
  return synthesize(sources);
});
```

Same applies inside `schedule({ cron: ... }, async () => { while (...) ... })` and `hook(...)`. Simplest path — no new imports.

### 2. `whileCondition` pattern — phase-level loop

When the loop is **a body of phases**, you want per-iteration events in the JobStore, and you may want to compose it with other phases:

```ts
import { runPipeline, PipelineCache } from '@autonome-research/thread-phase';
import { whileCondition } from '@autonome-research/thread-phase/patterns';
import type { Phase, BasePipelineContext } from '@autonome-research/thread-phase';

interface Ctx extends BasePipelineContext {
  sources: string[];
  sufficient: boolean;
}

const search: Phase<Ctx> = {
  name: 'search',
  async *run(ctx) {
    const found = await searchOnce();
    ctx.sources.push(...found);
    yield { type: 'data', key: 'count', value: ctx.sources.length };
  },
};

const assess: Phase<Ctx> = {
  name: 'assess',
  async *run(ctx) {
    ctx.sufficient = ctx.sources.length >= 6;
  },
};

const research = whileCondition<Ctx>('research-loop', {
  predicate: (ctx) => !ctx.sufficient,
  body: [search, assess],
  maxIterations: 10,
});

const ctx: Ctx = { cache: new PipelineCache(), sources: [], sufficient: false };
for await (const event of runPipeline([research, synthesizePhase], ctx)) {
  // each search/assess iteration yields events through this stream
}
```

`whileCondition` emits `${name}.converged` on clean exit, `${name}.max-iterations` if the cap hits (and sets `ctx.stop`).

### 3. `withRetry` wrapper — "loop until success"

When the loop is specifically "retry this phase on failure with exponential backoff":

```ts
import { withRetry } from '@autonome-research/thread-phase/patterns';

const reliableFetch = withRetry(fetchPhase, {
  maxAttempts: 5,
  baseDelayMs: 1000,
});
// Use reliableFetch anywhere fetchPhase would go.
```

Retries on both thrown exceptions and `ctx.stop` set; override with `isFailure` for finer control.

### Decision rule

| Shape | Use |
|---|---|
| Loop entirely in one handler, no need for per-iteration framework events | plain `while` inside `oneShot` / `schedule` / `hook` |
| Loop is a body of phases, want per-iteration JobStore log entries | `whileCondition` |
| Loop is "retry on failure" | `withRetry` |
| Loop is "synthesizer + critic with structured re-run signal" | `whileCondition` with the critic in the body — see [`docs/recipes.md`](./packages/thread-phase/docs/recipes.md) |

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

## API conventions — three factory shapes

The public API uses **three deliberately-distinct factory signatures**. Each shape tracks a real semantic category. Match the shape to the kind of thing you're building.

### 1. Pattern factories — `(name, options) → Phase<TCtx>`

Produce a `Phase` that gets composed into a pipeline. The `name` shows up in telemetry, event metadata, and error traces — it's not cosmetic.

```ts
parallelPhases('fanout', [phaseA, phaseB])
intentGate('classify-intent', { classify, route })
match('route-by-intent', { selector, cases, default: ... })
whileCondition('converge', { predicate, body, maxIterations })
withRetry('flaky-call', innerPhase, { maxAttempts, baseDelayMs })   // wrapper variant
subPipeline('nested', { phases, mapInput, mapOutput })
```

### 2. Eager runners — `(options) → Promise<T>`

Execute immediately and return a `Promise`. They do **not** return a `Phase` — they're invoked inline from inside a phase body. No `name` parameter because there's no Phase identity to attach it to.

```ts
const results = await boundedFanout({ items, concurrency, runner })
const results = await boundedFanoutOf({ items, concurrency, adapter, buildConfig })
```

### 3. Registration helpers — `(spec/handler, options?) → ExtensionRegisterFn`

Top-level entry points that **register** a pipeline with the CLI auto-loader. The first arg is the meat (spec or handler); options are secondary. They auto-derive the pipeline name from the calling file via `deriveNameFromCaller`, so you don't pass one explicitly.

```ts
export default oneShot(async (ctx) => { ... })
export default schedule({ cron: '0 * * * *' }, async (ctx) => { ... })
export default hook({ path: '/webhook' }, async (body, ctx) => { ... }, { validate: ... })
```

### Why three shapes (and why you should respect them)

These conventions encode three different relationships with the framework:

| Category | Returns | Identity needed? | Lifecycle |
|---|---|---|---|
| Pattern factory | `Phase<TCtx>` | Yes — survives into runtime telemetry | Inert until orchestrator runs the phase |
| Eager runner | `Promise<T>` | No — caller already has context | Runs at call site |
| Registration helper | `ExtensionRegisterFn` | Auto-derived from caller filename | Hooked into trigger lifecycle by the CLI |

When authoring a new factory, pick the category that matches what you're building and use that shape exactly. Mixing categories (e.g. an eager runner that takes `(name, options)`) muddles the convention without adding anything.

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

## Checkpoint / resume (v4.1.0+)

Linear pipelines can be resumed: phases marked with a `checkpointKey` are skipped on rerun if the prior run already completed them. The framework records `phase_complete` events; the caller derives `completedKeys` from those events and passes them to `runPipeline`.

**The agent-author rule of thumb:** add `checkpointKey` to phases that are slow OR have observable side effects you don't want to repeat. Leave it off cheap, idempotent phases — re-running them on resume is harmless and not adding the key is one fewer thing to think about.

```ts
import {
  runPipeline,
  completedCheckpointsFromEvents,
  SqliteJobStore,
  JobRunner,
} from '@autonome-research/thread-phase';

// Each slow/side-effecting phase gets a stable, unique checkpoint key.
const phases = [
  { name: 'fetch',  checkpointKey: 'fetched-v1',  async *run(ctx) { /* slow network */ } },
  { name: 'process', checkpointKey: 'processed-v1', async *run(ctx) { /* expensive compute */ } },
  { name: 'publish', async *run(ctx) { /* cheap; re-run safely */ } },
];

// Original run via JobRunner — completed phases are recorded in the event log.
const store = new SqliteJobStore();
const runner = new JobRunner(store);
const jobId = await runner.create('digest', null);
await runner.run(jobId, phases, makeCtx());

// On resume: derive completedKeys from the prior run's events.
const events = await store.getEvents(jobId);
const completedKeys = completedCheckpointsFromEvents(events.map(e => e.data));
await runPipeline(phases, makeCtx(), { resume: { completedKeys } });
// → publish runs again; fetch + process are skipped.
```

Resume restores **orchestrator position only** — not the cache, not `ctx.stop`, not Thread state, not memory. The caller is responsible for rebuilding ctx into a state the skipped phases would have left it in (typically by hydrating from your own persisted state alongside the JobStore event log).

If you change a `checkpointKey` value, the corresponding phase will re-run on resume (because the new key isn't in the existing log). Use this to force-rerun a phase after fixing a bug in it — bump the version suffix on the key.

---

## Durability — heartbeat + ownership + read-time staleness (v4.1.0+)

When using `JobRunner` as the primary runtime (cron pipelines, webhook handlers, long-running runs), opt into durability:

```ts
const runner = new JobRunner(store, { heartbeatMs: 15_000 });

// Phases with long inner loops should also manually refresh
async *run(ctx) {
  for (const item of items) {
    await processItem(item);
    await ctx.heartbeat?.();   // refresh between iterations
  }
}

// Operator script: detect dead runs
const dead = await store.listJobs({ status: 'STALE', staleAfterMs: 60_000 });
for (const job of dead) {
  await store.setFailed(job.id, `process ${job.pid} disappeared at ${job.heartbeatAt}`);
}
```

Ownership metadata (`pid`, `ppid`, `cwd`, `hostname`, `sessionId`) is auto-populated by `JobRunner.run` at `setRunning` time. `STALE` is a read-time computed status — passing `staleAfterMs` to `getJob` / `listJobs` does NOT modify the persisted row.

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
  grokBotAgent,
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
