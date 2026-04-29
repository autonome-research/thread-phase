# AGENTS.md — thread-phase

> **Audience:** LLM agents (Claude Code, Cursor, Codex, Cline, GitHub Copilot, etc.) generating TypeScript code that **uses** the thread-phase library. Not for agents working *on* this repo's source — that case should read `CONTRIBUTING.md`.
>
> **How to use:** Load this file as context when a user asks you to write a thread-phase automation, agent pipeline, or cron task. Refer back as needed. The reference card at the bottom gives you import lines you can copy.
>
> **If you're a human reading this:** the [README](./README.md) and [docs/patterns.md](./docs/patterns.md) are probably more useful — this doc is dense and assumes you can pattern-match on code.

---

## TL;DR

thread-phase is a TypeScript framework for **iterated tool-use agents composed into multi-phase pipelines**. The headline use case is *structuring repeatable agentic automations* — cron jobs, systemd timers, CI steps — beyond a single `claude -p "..."` invocation. The framework gives you typed phase boundaries, persistent event logs, and structured agent results so the parts of the automation that should be reliable are reliable, and the parts that should be agent judgment stay agent judgment.

You are most often using thread-phase when:
- A task has 2+ steps that need to run in a specific order
- One or more steps involve calling an LLM, possibly with tools
- The task is repeatable (cron / systemd / CI) and shouldn't re-derive its plan every run
- You want to verify the agent's claimed output before recording success
- You want event logs you can read back later to debug what happened

You are NOT using thread-phase when:
- The task is "ask the LLM one question and print the answer" — just call `runAgentWithTools` directly, no pipeline needed
- The task is a complex DAG with cross-edges — use Temporal/LangGraph/Inngest, embedding `runAgentWithTools` inside their nodes
- The task needs Anthropic's content-block model (vision, citations, extended thinking) — use the Anthropic SDK directly

---

## The mental model

Three primitives. Memorize these — everything else is composition.

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

// 3. runAgentWithTools is the streaming tool-use loop. Calls happen
//    inside phases (or directly, if you don't need a pipeline).
async function runAgentWithTools(
  config: AgentConfig,
  messages: Message[],
  options: AgentRunnerOptions,
): Promise<AgentRunResult>;
```

Composition rule: **mutate `ctx` for results, `yield` for progress events.** Never return data from `run` — write it to ctx and read it back in a downstream phase via `requireCtx`.

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
| N items, want to run an agent on each, capped concurrency | `boundedFanout` |
| Same, want progress events as items finish | `streamingBoundedFanout` |
| ≤2 items where concurrency-capping is overhead | `parallelFanout` (or just `Promise.all`) |
| Two distinct phases that should run concurrently as one composite | `parallelPhases` |
| Cheap classifier that decides whether the rest of the pipeline runs | `intentGate` |
| Score feasibility before spending big-model tokens | `preflightConfidence` |
| Synthesizer that may want to re-run upstream phases | `synthesizeWithFollowup` |
| Want to verify a sample of typed claims | `spotCheck` |

If none fit, write a `Phase` directly. Patterns are convenience, not requirement.

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
  parallelFanout,
  boundedFanout,
  streamingBoundedFanout,
  parallelPhases,
  intentGate,
  preflightConfidence,
  synthesizeWithFollowup,
  spotCheck,
} from 'thread-phase/patterns';
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
