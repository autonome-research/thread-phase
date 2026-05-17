# thread-phase-agents

Adapter implementations for the `AgentAdapter` protocol from [`thread-phase`](https://github.com/Code4me2/thread-phase). Wraps heterogeneous AI agents — CLI-based coding agents, in-process SDK agents — behind a single uniform shape so thread-phase pipelines can compose them.

## Install

```bash
npm install thread-phase-agents thread-phase
```

`thread-phase` is a peer dependency. Each adapter has its own dependency on whichever SDK or CLI it wraps:

| Adapter | Requires |
|---|---|
| `acpAgent` (chassis) | An ACP-speaking subprocess on your machine |
| `hermesAgent` | `hermes` CLI in PATH (https://github.com/...) |
| `openClawAgent` | `acpx` in PATH; optional NemoClaw sandbox |
| `claudeCodeAgent` | `claude` CLI in PATH (https://claude.com/code) |
| `codexCliAgent` | `codex` CLI in PATH (`codex login` for auth) |
| `codexAgent` | `OPENAI_API_KEY` env var (Responses API direct) |
| `anthropicAgent` | `ANTHROPIC_API_KEY` env var |
| `piAgent` | `@mariozechner/pi-coding-agent` (already bundled), pi config under `~/.pi/agent/` |

## What's in here

Seven adapter implementations plus a shared ACP chassis:

- **`acpAgent`** — the [Agent Client Protocol](https://agentclientprotocol.com/) chassis. Spawns any ACP-speaking subprocess, parses JSON-RPC over stdio, drives `initialize → session/new → session/prompt → session/cancel`. Other ACP-based adapters compose on top.
- **`hermesAgent`** — wraps `hermes acp`. Inherits the ACP chassis.
- **`openClawAgent`** — wraps `acpx` against the OpenClaw Gateway, with optional `sandbox: 'nemoclaw' | 'local'` mode.
- **`anthropicAgent`** — in-process via `@anthropic-ai/sdk`. Streaming + tool use + extended thinking.
- **`codexAgent`** — in-process via OpenAI Responses API. Requires `OPENAI_API_KEY`.
- **`codexCliAgent`** — subprocess wrapper around `codex exec --json`. Uses codex's own auth (ChatGPT subscription OAuth typically).
- **`claudeCodeAgent`** — subprocess + JSONL streaming. Forgiving parser falls back to `native` events for unknown shapes.
- **`piAgent`** — in-process via `@mariozechner/pi-coding-agent`. The only adapter where `SteerableAgentRun.steer()` and `.followUp()` work natively at runtime (pi accepts mid-stream steering).

## Using an adapter

The basic shape is the same for every adapter — call `meta.adapter(config)` to get an `AgentRun`, then iterate events and/or await the result:

```ts
import { hermesAgent } from 'thread-phase-agents';

const run = hermesAgent.adapter({
  cwd: process.cwd(),
  prompt: 'List the files in this directory and summarize what they are.',
});

// Stream events for display / logging:
for await (const event of run.events) {
  if (event.type === 'text') process.stdout.write(event.delta);
}

// Await the final result:
const result = await run.result;
console.log('finishReason:', result.finishReason);
console.log('text:', result.text);
console.log('resumeToken:', result.resumeToken);
```

`run.result` never rejects — errors are encoded as `finishReason: 'error'` with an `error` event in the stream beforehand. `run.events` is a single-consumer iterable; use the `AgentEventBus` from `thread-phase/agents` if you need fan-out to multiple subscribers.

### Inside a thread-phase phase

Adapters compose with thread-phase's pipeline primitives. The canonical pattern:

```ts
import { JobRunner, SqliteJobStore, type Phase } from 'thread-phase';
import { createEventBus, pipeAgentEventsToJobStore } from 'thread-phase/agents';
import { claudeCodeAgent } from 'thread-phase-agents';

interface Ctx {
  taskDescription?: string;
  result?: string;
}

const reviewPhase: Phase<Ctx> = {
  name: 'review',
  async *run(ctx, { jobId, store, signal }) {
    yield { type: 'phase', phase: 'review', detail: 'starting claude-code' };

    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, { dropTypes: ['text'] });

    const run = claudeCodeAgent.adapter(
      { cwd: process.cwd(), prompt: ctx.taskDescription! },
      { signal, eventBus: bus, traceId: jobId },
    );

    const result = await run.result;
    ctx.result = result.text;
    yield { type: 'data', key: 'result', value: { length: result.text.length } };
  },
};
```

`pipeAgentEventsToJobStore` wires the adapter's event stream into the JobStore log so every text delta / tool call / turn boundary is persisted. The `dropTypes: ['text']` filter keeps the high-volume text deltas out of the database while preserving tool calls, turn boundaries, and lifecycle events for audit.

### Memory and Thread auto-wiring

Decorate any adapter with `withMemory` to plumb a `MemoryProvider` automatically, or `withThread` to flow conversation state across phases. Use the pre-built injectors from this package so you don't have to write per-adapter splicing logic:

```ts
import { withMemory, withThread, createThread } from 'thread-phase/agents';
import { claudeCodeAgent, injectMemory, injectResume } from 'thread-phase-agents';

const thread = createThread();

const augmented = withThread(
  withMemory(claudeCodeAgent, {
    scope: { userId: 'alice' },
    inject: injectMemory.claudeCode,
  }),
  thread,
  { applyResume: injectResume.claudeCode },
);

// First call — creates a session, fills thread.events.
await augmented.adapter({ cwd, prompt: 'analyze this codebase' }, { memoryProvider }).result;

// Second call — same thread; the wrapper reads thread.resumeTokens['claude-code']
// and adds --resume <id> automatically.
await augmented.adapter({ cwd, prompt: 'now refactor the file you mentioned' }, { memoryProvider }).result;
```

### Steerable runs (pi, hermes, openclaw)

Adapters whose underlying runtime supports follow-up prompts on a live session return a `SteerableAgentRun` at runtime. Narrow with `isSteerable` from `thread-phase/agents`:

```ts
import { isSteerable } from 'thread-phase/agents';
import { piAgent } from 'thread-phase-agents';

const run = piAgent.adapter({ cwd, prompt: 'start something complex' });

if (isSteerable(run)) {
  // Pi accepts mid-stream steering — interrupt the current generation
  // and add context.
  await run.steer('reconsider, the user just clarified X');

  // Or queue a follow-up that fires after the current response completes:
  await run.followUp('and then also summarize');
}

const result = await run.result;
```

- `piAgent` supports both `steer()` (mid-generation injection) and `followUp()` (queued additional turn).
- `hermesAgent` / `openClawAgent` / `acpAgent` support `followUp()` (ACP's `session/prompt` is discrete — multiple prompts on one session). `steer()` rejects with a capability error.
- All other adapters (`claudeCodeAgent`, `codexCliAgent`, `codexAgent`, `anthropicAgent`) are not steerable. `isSteerable(run)` returns `false`.

### Cross-adapter handoff with Thread

When two phases use different adapters, the canonical event log in a shared `Thread` becomes the bridge. Same-adapter chains resume natively via the resume token (lossless); cross-adapter chains fall back to a text rendering of the thread:

```ts
import { createThread } from 'thread-phase/agents';
import {
  claudeCodeAgent,
  anthropicAgent,
  threadToAnthropicMessages,
} from 'thread-phase-agents';

const thread = createThread();

// Phase A: claude-code does research.
const runA = withThread(claudeCodeAgent, thread, { applyResume: injectResume.claudeCode });
await runA.adapter({ cwd, prompt: 'investigate the bug in foo.ts' }).result;

// Phase B: anthropic synthesizes a report from claude-code's findings.
// Different adapter — render the thread to anthropic message format.
const messages = threadToAnthropicMessages(thread);
const runB = anthropicAgent.adapter({
  model: 'claude-opus-4-7',
  messages: [...messages, { role: 'user', content: 'Write a 3-bullet summary.' }],
});
await runB.result;
```

The `threadTo<Adapter>{Prompt,Messages,Input}` helpers render the shared event log into each adapter's expected input shape.

## Smoke scripts

Each adapter has a runnable real-binary smoke test under `scripts/`:

```bash
npx tsx scripts/smoke-claude-code.ts "say hello"
npx tsx scripts/smoke-hermes.ts
npx tsx scripts/smoke-codex-cli.ts
npx tsx scripts/smoke-pi.ts
```

Useful for sanity-checking that the adapter survives contact with whichever version of the binary you have installed. They print every canonical event as it streams and report pass/fail at the end.

## Relationship to thread-phase

[`thread-phase`](https://github.com/Code4me2/thread-phase) owns the `AgentAdapter` protocol, the `Thread` primitive, the canonical `AgentEvent` vocabulary, the `inferenceAgent` (which wraps `runAgentWithTools` against any OpenAI-compatible endpoint), and the conformance suite that every adapter must pass.

This package ships the *other* adapters — the ones that delegate to pre-built coding / research / life agents rather than driving a raw inference loop. Each adapter passes the conformance suite imported from `thread-phase/agents/test-utils`.

## Status

Pre-1.0. The adapter set covers the common heterogeneous-agent surface; the API shape may still change before 1.0.

## License

MIT.
