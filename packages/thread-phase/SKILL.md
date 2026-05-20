---
name: thread-phase
description: Use when the user asks to build a structured agent pipeline, compose multiple agent calls into a deterministic workflow, run agents on a cron/schedule, fan an agent across N items with capped concurrency, chain heterogeneous agents (claude-code → anthropic → codex), persist agent events to a job log, wire memory or session resumption across agent calls, or set up "research loops"/"development loops" with multiple coding agents handing off work. Triggers include phrases like "multi-phase pipeline", "thread-phase", "AgentAdapter", "run claude code in a loop", "bounded fanout over items", "verifyResult", "persist agent events", "Honcho memory" / Letta / Mem0 wiring around agents, "structure a research workflow", or any time the user is composing claude-code/codex/hermes/pi with each other or with raw model calls.
---

# thread-phase — agent pipeline orchestration in TypeScript

Two npm packages working together:

- **`thread-phase`** (v1.5.x) — the framework: `Phase`, `runPipeline`, `runAgentWithTools`, `JobRunner`, plus the `AgentAdapter` protocol under the `thread-phase/agents` subpath.
- **`thread-phase-agents`** (v0.1.x) — adapter implementations for ready agents: `claudeCodeAgent`, `codexCliAgent`, `codexAgent`, `hermesAgent`, `openClawAgent`, `anthropicAgent`, `piAgent`, plus the shared ACP chassis.

```bash
npm install thread-phase thread-phase-agents
```

## When to reach for thread-phase

- The task has 2+ phases that run in a specific order with typed handoff (`fetch → triage → review → compose`)
- One or more phases call an LLM, possibly with tools
- The task is repeatable (cron / systemd / CI) and shouldn't re-derive its plan every run
- Multiple agents collaborate (claude-code does code edits, anthropic synthesizes a report, etc.)
- You want persistent event logs + replay
- You want bounded-concurrency fanout over a list

When **not** to reach for it:
- Single-turn "ask an LLM and print" — use the SDK directly
- A complex DAG with cross-edges — use Temporal/LangGraph/Inngest and embed thread-phase in nodes

## Mental model: three primitives + one extension surface

```ts
// 1. Phase: typed unit of work. Reads ctx, yields events, writes outputs back to ctx.
interface Phase<TCtx extends BasePipelineContext> {
  readonly name: string;
  run(ctx: TCtx): AsyncGenerator<PipelineEvent, void>;
}

// 2. runPipeline: runs an array of phases in order.
async function* runPipeline<TCtx>(phases: Phase<TCtx>[], ctx: TCtx): AsyncGenerator<PipelineEvent>;

// 3. runAgentWithTools: the iterated tool-use loop against OpenAI-compatible inference.
async function runAgentWithTools(config, messages, options): Promise<AgentRunResult>;

// 4. AgentAdapter: protocol for delegating to a ready agent (claude-code, hermes, codex, ...)
type AgentAdapter<TConfig> = (config, options?) => AgentRun;
// AgentRun has { events: AsyncIterable<AgentEvent>, result: Promise<AgentRunResult>, abort() }
```

**Composition rule:** mutate `ctx` for results, `yield` for progress events. Never return data from `run` — write to ctx, read it back downstream via `requireCtx(ctx, 'fieldName', 'phaseName')`.

## Smallest useful pipeline

```ts
import {
  JobRunner, SqliteJobStore, PipelineCache,
  runAgentWithTools, requireCtx,
  loadInferenceConfig, createInferenceClient,
  type Phase, type BasePipelineContext, type ToolExecutor,
} from 'thread-phase';

interface Ctx extends BasePipelineContext { question?: string; answer?: string; }

const config = loadInferenceConfig();
const client = createInferenceClient();
const noTools: ToolExecutor = { async execute() { return { toolCallId: '', content: '' }; } };

const answerPhase: Phase<Ctx> = {
  name: 'answer',
  async *run(ctx) {
    const q = requireCtx(ctx, 'question', 'answer');
    const r = await runAgentWithTools(
      { name: 'answer', systemPrompt: 'Answer concisely.', model: config.defaultModel,
        tools: [], maxToolRounds: 1, maxTokens: 500 },
      [{ role: 'user', content: q }],
      { client, toolExecutor: noTools, cache: ctx.cache,
        verifyResult: (r) => { if (r.finishReason === 'length') throw new Error('truncated'); return r; } },
    );
    ctx.answer = r.text;
  },
};

const runner = new JobRunner(new SqliteJobStore('./jobs.db'));
const jobId = runner.create('quick-answer', { startedAt: new Date().toISOString() });
process.on('SIGTERM', () => runner.cancel(jobId, 'systemd timeout'));
await runner.run(jobId, [answerPhase], { cache: new PipelineCache(), question: 'What is 2+2?' });
```

## Choosing an adapter

| You want… | Use | Why |
|---|---|---|
| Cheap raw-model call (classification, formatting, summarization) | `runAgentWithTools` directly (no adapter) | Smallest surface, no subprocess. |
| Cheap raw-model call **with tool access** (read files, run bash, grep) | `runAgentWithTools` with a real `ToolExecutor` | Define `ToolDefinition[]` for the tools, register a `ToolRegistry`. |
| Multi-file refactor / debugging / real engineering work | `claudeCodeAgent` | Spawns the real `claude` CLI. Claude Code's tool suite + system prompt apply. |
| Same shape via OpenAI ChatGPT subscription | `codexCliAgent` | Spawns `codex exec --json`. Uses codex's own auth. |
| Direct Responses API (have an OpenAI API key) | `codexAgent` | In-process via the openai npm SDK. |
| Direct Anthropic API | `anthropicAgent` | In-process via `@anthropic-ai/sdk`. |
| Long-running research loop with follow-up prompts on the same session | `hermesAgent` | ACP-native; supports `followUp()`. |
| Recursive agent loop (agent runs another agent loop) | `piAgent` | The **only** adapter where mid-stream `steer()` works at runtime. |
| OpenClaw via `acpx` | `openClawAgent` | Gateway must be running. |

**Rule of thumb:** default to `runAgentWithTools` for cheap text work. Reach for a sibling adapter only when the underlying ready-agent's tool suite or model class is materially better than what you'd configure manually.

## Using a sibling adapter

Every adapter has the same shape — call `meta.adapter(config)` and you get an `AgentRun`:

```ts
import { claudeCodeAgent } from 'thread-phase-agents';

const run = claudeCodeAgent.adapter({
  cwd: '/path/to/repo',
  prompt: 'Refactor src/utils.ts to use the new logger.',
  // optional: resumeSessionId, claudeArgs (full argv override), env, killGraceMs
});

// Stream events for progress display:
for await (const event of run.events) {
  if (event.type === 'text') process.stdout.write(event.delta);
  if (event.type === 'tool_call') console.log(`[tool] ${event.name}`);
}

// Await the final result:
const result = await run.result;
console.log('finishReason:', result.finishReason);   // 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' | ...
console.log('text:', result.text);
console.log('resumeToken:', result.resumeToken);     // pass back as resumeSessionId next call
```

Critical invariants the protocol enforces (and the conformance suite verifies):

- `run.result` **always resolves**, never rejects. Errors land in `finishReason: 'error'` with a prior `error` event.
- `run.events` is **single-consumer**. Iterate it once. For multi-cast use `AgentEventBus` (see "Persistence" below).
- `run.abort()` is idempotent.
- The events stream emits `agent_start` first, `agent_end` last, exactly one of each.

## Tool integration with `runAgentWithTools`

The canonical pattern for text + tools without spawning a subprocess agent:

```ts
import { ToolRegistry, runAgentWithTools } from 'thread-phase';

const tools = new ToolRegistry().register(
  {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async (args) => fs.readFileSync(args.path as string, 'utf8'),
);

const r = await runAgentWithTools(
  { name: 'reader', systemPrompt: 'Read the file the user asks for.',
    model: config.defaultModel, tools: tools.definitions(),
    maxToolRounds: 3, maxTokens: 500 },
  [{ role: 'user', content: 'Read foo.txt and summarize it.' }],
  { client, toolExecutor: tools, cache: ctx.cache,
    verifyResult: (r) => {
      const calledRead = r.executedToolCalls.some(tc => tc.name === 'read_file');
      if (!calledRead) throw new Error('agent claimed to read but never called read_file');
      return r;
    },
  },
);
```

`r.executedToolCalls` is the ground truth (which tools the agent actually invoked). Use `verifyResult` to catch confabulation where a small model says "I read the file" without calling the tool.

## Memory across runs — withMemory + Honcho/Letta/Mem0

thread-phase ships only the `MemoryProvider` interface:

```ts
interface MemoryProvider {
  recall(scope: MemoryScope, query?: string): Promise<string>;
  remember(scope: MemoryScope, events: ReadonlyArray<AgentEvent>): Promise<void>;
}
interface MemoryScope { userId: string; appId?: string; sessionId?: string; }
```

Implementations live in userland (Honcho example in `examples/honcho-memory.ts` in the thread-phase repo). To plumb a provider into an adapter automatically, wrap with `withMemory`:

```ts
import { withMemory } from 'thread-phase/agents';
import { claudeCodeAgent, injectMemory } from 'thread-phase-agents';

const memoryAware = withMemory(claudeCodeAgent, {
  scope: { userId: ctx.userId },
  inject: injectMemory.claudeCode,    // pre-built splicer — knows where each adapter puts memory
  query: (cfg) => cfg.prompt,          // optional: refine recall by this query
});

const run = memoryAware.adapter(
  { cwd, prompt: 'continue what we were working on yesterday' },
  { memoryProvider: honchoProvider },
);
```

`injectMemory` has entries for every bundled adapter: `injectMemory.{inference,anthropic,codex,claudeCode,codexCli,acp,hermes,openClaw,pi}`. Same for `injectResume`.

`withMemory` is a no-op when `options.memoryProvider` is absent — decorate once at module load, pass the provider per-call where appropriate.

## Threading state across phases — Thread + withThread

Phase A runs claude-code; phase B continues the same conversation. The canonical primitive is `Thread`:

```ts
import { createThread, withThread } from 'thread-phase/agents';
import { claudeCodeAgent, injectResume } from 'thread-phase-agents';

const thread = createThread();

const adapter = withThread(claudeCodeAgent, thread, {
  applyResume: injectResume.claudeCode,
});

// Phase A — creates session, captures the session id into thread.resumeTokens['claude-code'].
await adapter.adapter({ cwd, prompt: 'analyze this codebase' }).result;

// Phase B — same thread; wrapper reads the token and adds --resume <id> automatically.
await adapter.adapter({ cwd, prompt: 'refactor the file you mentioned' }).result;
```

Cross-adapter handoff (different adapters in successive phases) renders the canonical event log to text via the bridge helpers in `thread-phase-agents`:

```ts
import { threadToAnthropicMessages, threadToClaudeCodePrompt } from 'thread-phase-agents';

// Phase A used claude-code; phase B is anthropic — render the thread to MessageParam[].
const messages = threadToAnthropicMessages(thread);
const run = anthropicAgent.adapter({
  model: 'claude-opus-4-7',
  messages: [...messages, { role: 'user', content: 'write a 3-bullet summary' }],
});
```

Lossy by design — cross-adapter handoff loses adapter-native fidelity (tool result blocks become text). Same-adapter chains use the resume token for full fidelity.

## Persistence: EventBus → JobStore

Every adapter emits canonical events through `options.eventBus`. To persist them to the job log:

```ts
import { createEventBus, pipeAgentEventsToJobStore } from 'thread-phase/agents';

const phase: Phase<Ctx> = {
  name: 'review',
  async *run(ctx, { jobId, store, signal }) {
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, {
      dropTypes: ['text'],   // skip high-volume text deltas; keep tool calls, turn boundaries, lifecycle
    });

    const run = claudeCodeAgent.adapter(
      { cwd, prompt: 'review the diff' },
      { signal, eventBus: bus, traceId: jobId },
    );
    const result = await run.result;
    ctx.review = result.text;
  },
};
```

`dropTypes: ['text']` is the typical move — text deltas balloon the event log, but tool calls and turn boundaries are useful for audit and debugging.

## Patterns

```ts
import {
  boundedFanout, boundedFanoutOf, streamingBoundedFanout,
  parallelFanout, parallelPhases,
  intentGate, preflightConfidence, synthesizeWithFollowup, spotCheck,
} from 'thread-phase/patterns';
```

| Shape | Pattern |
|---|---|
| N items, free-function runner, capped concurrency | `boundedFanout` |
| N items, AgentAdapter per item, capped concurrency, automatic event bus | `boundedFanoutOf` |
| Same as boundedFanout but yields events as items finish | `streamingBoundedFanout` |
| ≤2 items where capping is overhead | `parallelFanout` (or just `Promise.all`) |
| Two distinct phases that should run concurrently | `parallelPhases` |
| Cheap classifier decides whether the heavy pipeline runs | `intentGate` |
| Score feasibility before spending big-model tokens | `preflightConfidence` |
| Synthesizer may re-run upstream phases | `synthesizeWithFollowup` |
| Verify a sample of typed claims | `spotCheck` |

**`boundedFanoutOf` — the adapter-driven sibling of `boundedFanout`:**

```ts
import { boundedFanoutOf } from 'thread-phase/patterns';
import { claudeCodeAgent } from 'thread-phase-agents';

const results = await boundedFanoutOf({
  items: filesToReview,
  concurrency: 3,
  adapter: claudeCodeAgent,
  buildConfig: (file) => ({ cwd: '/repo', prompt: `Review ${file}` }),
  signal: ctx.signal,
  eventBus: ctx.bus,          // every parallel run's events land here
  mode: 'collect',            // or 'fail-fast' (default)
});
// results: AgentRunResult[] in input order
```

## Steerable runs — isSteerable, followUp, steer

ACP-based adapters (`hermesAgent`, `openClawAgent`, the chassis `acpAgent`) and `piAgent` return a `SteerableAgentRun` at runtime. Narrow safely with `isSteerable`:

```ts
import { isSteerable } from 'thread-phase/agents';
import { piAgent, hermesAgent } from 'thread-phase-agents';

const run = piAgent.adapter({ cwd, prompt: 'start the analysis' });

if (isSteerable(run)) {
  // pi natively accepts mid-stream steering:
  await run.steer('reconsider, the user clarified X');

  // Or queue a follow-up that fires after the current turn:
  await run.followUp('and then also summarize');
}
```

| Adapter | `steer()` | `followUp()` |
|---|---|---|
| `piAgent` | ✅ (mid-stream) | ✅ (queued) |
| `hermesAgent` / `openClawAgent` / `acpAgent` | ❌ (rejects with capability error) | ✅ (queued — sends another `session/prompt`) |
| All others | not steerable; `isSteerable(run)` returns `false` |

## Verification — catching silent confabulation

```ts
verifyResult: (result) => {
  if (result.finishReason === 'length') throw new Error('output truncated');
  const claimed = /I wrote .* to file/.test(result.text);
  const actuallyWrote = result.executedToolCalls.some(tc => tc.name === 'write_file');
  if (claimed && !actuallyWrote) throw new Error('agent claimed write but never called write_file');
  return result;
}
```

Small models confabulate. `executedToolCalls` is the ground truth — use `verifyResult` to enforce that claims match actions before recording success.

## Canonical heterogeneous-pipeline template

```ts
import { JobRunner, SqliteJobStore, PipelineCache, requireCtx, type Phase } from 'thread-phase';
import { createEventBus, pipeAgentEventsToJobStore } from 'thread-phase/agents';
import { claudeCodeAgent, anthropicAgent, hermesAgent } from 'thread-phase-agents';
import { boundedFanoutOf } from 'thread-phase/patterns';

interface Ctx { workdir: string; files: string[]; reviews?: string[]; summary?: string; }

const reviewPhase: Phase<Ctx> = {
  name: 'review',
  async *run(ctx, { jobId, store, signal }) {
    const files = requireCtx(ctx, 'files', 'review');
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, { dropTypes: ['text'] });

    const results = await boundedFanoutOf({
      items: files, concurrency: 3,
      adapter: claudeCodeAgent,
      buildConfig: (f) => ({ cwd: ctx.workdir, prompt: `Review ${f}` }),
      signal, eventBus: bus, mode: 'collect',
    });
    ctx.reviews = results.map(r => r.text);
  },
};

const summarizePhase: Phase<Ctx> = {
  name: 'summarize',
  async *run(ctx) {
    const reviews = requireCtx(ctx, 'reviews', 'summarize');
    const run = anthropicAgent.adapter({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: `Summarize these reviews:\n${reviews.join('\n---\n')}` }],
      systemPrompt: 'You write executive summaries.',
    });
    const result = await run.result;
    ctx.summary = result.text;
  },
};

const runner = new JobRunner(new SqliteJobStore('./jobs.db'));
const jobId = runner.create('code-review', {});
process.on('SIGTERM', () => runner.cancel(jobId, 'shutdown'));
await runner.run(jobId, [reviewPhase, summarizePhase],
  { cache: new PipelineCache(), workdir: '/repo', files: ['a.ts', 'b.ts', 'c.ts'] });
```

## Anti-patterns to avoid

- **Reading `ctx.field` without `requireCtx`** — silently passes `undefined` if upstream didn't run. Always use `requireCtx(ctx, 'field', 'phaseName')`.
- **Trusting agent text without checking `finishReason`** — `'length'` means truncated; `parseJSON` fallback masks it. Always branch on `finishReason === 'length'` before parsing JSON.
- **Returning data from `Phase.run`** — the orchestrator ignores generator returns. Mutate `ctx` instead.
- **`tools: []` + `noTools` ToolExecutor when the prompt promises tools** — the agent will confabulate. Either register real tools or remove the tool-use language from the system prompt.
- **`fanoutConcurrency` higher than your inference backend's `--max-num-seqs`** — head-of-line blocking, no throughput gain.
- **Reaching for sibling adapters for simple text work** — each subprocess spawn costs 1-3s. Use `runAgentWithTools` for cheap classification/formatting/summarization.
- **Passing `systemPrompt` to a sibling adapter expecting it to apply** — sibling adapters (claude-code, hermes, etc.) have their own system prompts. Your `systemPrompt` is mostly ignored.
- **Running boundedFanoutOf with `claudeCodeAgent` over 50 items** — 50 claude subprocesses. Use `inferenceAgent` for fanout, reach for claude-code only on the items that actually need engineering depth.
- **Forgetting `verifyResult` on phases where output correctness matters** — silent failures are the worst kind.
- **Wiring SIGTERM/SIGINT to `runner.cancel`** is non-negotiable for cron-driven pipelines. Without it, a stuck inference call survives systemd's `TimeoutStartSec`.

## Reference card

```ts
// Core (thread-phase)
import {
  // 3 primitives
  runAgentWithTools, runPipeline,
  // Pipeline shape
  PipelineCache, requireCtx, type Phase, type BasePipelineContext, type PipelineEvent,
  // Inference / config
  loadInferenceConfig, createInferenceClient,
  // Persistence
  JobStore, SqliteJobStore, JobRunner, streamToSSE,
  // Tools + messages
  ToolRegistry, parseJSON, type Message, type ToolDefinition, type ToolExecutor, type ToolResult,
  // Agent result types
  type AgentConfig, type AgentRunResult, type AgentRunnerOptions, type FinishReason, type UsageInfo,
} from 'thread-phase';

// AgentAdapter protocol (thread-phase/agents)
import {
  // The protocol
  defineAgentAdapter, isSteerable,
  type AgentAdapter, type AgentAdapterMeta, type AgentRun, type AgentRunOptions, type AgentRunResult,
  type AgentEvent, type AgentEventBus, type AgentCapabilities,
  type SteerableAgentRun, type ResumeToken, type SerializableError,
  // Reference adapter
  inferenceAgent, type InferenceAgentConfig,
  // Thread primitive
  createThread, appendEvent, resumeTokenFor, setResumeToken, threadToMessages, type Thread,
  // Memory
  type MemoryProvider, type MemoryScope,
  // Decorators
  withMemory, withThread,
  // Event bus + JobStore bridge
  createEventBus, pipeAgentEventsToJobStore,
  // Structured output
  parseStructured, parseStructuredFromText, applyStructuredOutputPrompt, StructuredOutputParseError,
  // Helpers for adapter authors
  TurnAccumulator, composeAbort, createEventQueue, lazyEvents,
  // Capability assertions
  requireCapability, AgentCapabilityError, serializeError,
} from 'thread-phase/agents';

// Patterns (thread-phase/patterns)
import {
  boundedFanout, boundedFanoutOf, streamingBoundedFanout,
  parallelFanout, parallelPhases,
  intentGate, preflightConfidence, synthesizeWithFollowup, spotCheck,
} from 'thread-phase/patterns';

// Sibling adapters (thread-phase-agents)
import {
  acpAgent, createAcpAdapter,
  hermesAgent, openClawAgent,
  anthropicAgent, codexAgent, codexCliAgent,
  claudeCodeAgent, piAgent,
  // Pre-built inject callbacks
  injectMemory, injectResume,
  // Cross-adapter Thread → adapter-input renderers
  threadToTranscript, threadToAcpPrompt, threadToAnthropicMessages,
  threadToClaudeCodePrompt, threadToCodexInput,
} from 'thread-phase-agents';

// Test scaffolding (thread-phase/agents/test-utils)
import { createMockAgent, runAdapterConformance } from 'thread-phase/agents/test-utils';
```

## Versioning

- `thread-phase` ≥ 1.5.0 — includes `AgentAdapter` protocol + `pipeAgentEventsToJobStore`
- `thread-phase-agents` ≥ 0.1.0 — first release with the full adapter set

When generating code, use the patterns above. If the user's environment is pre-1.5 or pre-0.1, fall back to the v1.0-era `runAgentWithTools`-only approach (the framework is backward-compatible; only the new adapter surfaces require the bumped versions).
