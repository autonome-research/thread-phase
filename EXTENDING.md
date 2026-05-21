# Extending thread-phase

thread-phase is designed to be modified — by you, or by coding agents working in your project — without forking the core. This document is the map of extension surfaces, the conventions for each, and where to find canonical examples.

## TL;DR

```
your-project/
  .thread-phase/
    triggers/<name>.ts       register a Trigger        api.registerTrigger
    adapters/<name>.ts       register an AgentAdapter  api.registerAdapter
    pipelines/<name>.ts      register a Pipeline       api.registerPipeline
```

Each file exports a default function `(api: ThreadPhaseAPI) => void` that registers things. Then `npx thread-phase {run <name>|serve|list}` does the rest.

**Quickest start:** `npx thread-phase init my-project` scaffolds the layout above plus a sample `hello.ts`, then `cd my-project && npm install && thread-phase run hello`. See [`Three discovery tiers`](#three-discovery-tiers) below for how the loader finds your files — including the `thread-phase.extensions` manifest format for extensions that need their own npm deps (Tier 3).

## The extension surfaces

| Surface | What you register | Discovery dir | Why |
|---|---|---|---|
| **Triggers** | A `Trigger<TInput>` instance | `.thread-phase/triggers/` | Entry points: timers, webhook adapters, queue consumers, file watchers. |
| **Adapters** | An `AgentAdapterMeta` | `.thread-phase/adapters/` | Custom-flavored AgentAdapters (e.g. claude-code with project-specific flags). |
| **Pipelines** | A `PipelineSpec` | `.thread-phase/pipelines/` | Named pipelines runnable via `thread-phase run <name>` or auto-triggered in `serve`. |

**Patterns are not auto-loaded.** They're reusable factory functions — write them anywhere in your codebase and import them into your pipeline files. The CLI doesn't gate access to them.

## The contract

Every extension is a TypeScript (or JavaScript) file whose default export is a function:

```ts
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  // call api.registerTrigger / registerAdapter / registerPipeline
};
```

`ThreadPhaseAPI` has three methods:

```ts
interface ThreadPhaseAPI {
  registerTrigger<TInput>(name: string, trigger: Trigger<TInput>): void;
  registerAdapter<TConfig, TResult>(name: string, adapter: AgentAdapterMeta<TConfig, TResult>): void;
  registerPipeline<TCtx, TInput>(name: string, spec: PipelineSpec<TCtx, TInput>): void;
}
```

Name collisions throw with the path of the prior registration. Use the file path as the de facto namespace.

## Three discovery tiers

The loader scans each `.thread-phase/<kind>/` directory and supports three forms, in order of ceremony:

### Tier 1 — loose `.ts` or `.js` file

The simplest form. Most extensions live here.

```
.thread-phase/triggers/cron-15m.ts
```

```ts
import { TimerTrigger } from '@autonome-research/thread-phase/triggers';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger('cron-15m', new TimerTrigger({ intervalMs: 15 * 60_000 }));
};
```

### Tier 2 — folder with `index.ts`

When the extension needs sibling files (helpers, fixtures, types) but no extra npm dependencies.

```
.thread-phase/triggers/my-webhook/
  index.ts
  parsers.ts
  schemas.ts
```

`index.ts` has the default-export contract; siblings can be imported with relative paths.

### Tier 3 — folder with `package.json` manifest

When the extension needs its own npm dependencies (e.g. `fastify`, `redis`, `chokidar`). The manifest carries a `thread-phase.extensions` array pointing at one or more entry files:

```
.thread-phase/triggers/redis-stream/
  package.json
  index.ts
```

```json
{
  "private": true,
  "dependencies": { "ioredis": "^5.4.0" },
  "thread-phase": { "extensions": ["./index.ts"] }
}
```

Install with `npm install` from inside the extension folder, or set up a workspace.

## Shared code via `.thread-phase/lib/`

The loader only scans the three registered kinds (`triggers/`, `adapters/`, `pipelines/`). For shared user-side code — custom patterns, helpers, types used by more than one extension — the convention is `.thread-phase/lib/`.

Rules:

- Files under `.thread-phase/lib/` are **not auto-loaded**. They have no default-export contract.
- Other extensions reach into them via relative imports (`../lib/<name>.js`).
- Use it for: custom patterns (factory functions that return a `Phase`), shared `Ctx` interfaces, prompt strings, small utilities. Anything that would otherwise live in a registered file just because there was nowhere else to put it.
- A single-pipeline helper can stay inline in that pipeline. Promote to `lib/` once a second caller appears.

Why under `.thread-phase/` and not a top-level `lib/`? It keeps every thread-phase concern under one tree (so agents reading the project can locate the corpus by inspecting one directory) and stays out of the way of any `src/` or `lib/` the host project already uses for its application code.

Example layout:

```
.thread-phase/
  lib/
    poll-until.ts          ← a custom pattern wrapping whileCondition
  pipelines/
    poll-job.ts            ← imports { pollUntil } from '../lib/poll-until.js'
    poll-deployment.ts     ← imports the same helper
```

`lib/poll-until.ts`:

```ts
import { whileCondition } from '@autonome-research/thread-phase/patterns';
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';

export function pollUntil<TCtx extends BasePipelineContext>(
  name: string,
  options: { probe: Phase<TCtx>; done: (ctx: TCtx) => boolean | Promise<boolean>; maxIterations?: number },
): Phase<TCtx> {
  return whileCondition<TCtx>(name, {
    predicate: async (ctx) => !(await options.done(ctx)),
    body: [options.probe],
    maxIterations: options.maxIterations ?? 20,
  });
}
```

A pipeline imports it the same way it would any local module — see `examples/.thread-phase/pipelines/poll-job.ts` for a working caller.

## Per-extension failure isolation

If an extension throws during load (missing import, bad default export, runtime error inside the register function), the loader logs the path + error and **continues with the remaining extensions**. The CLI's other extensions still load, and `list` / `run` / `serve` still work for the ones that succeeded.

## How each surface registers

### Trigger

```ts
import { TimerTrigger } from '@autonome-research/thread-phase/triggers';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger(
    'morning-timer',
    new TimerTrigger({
      intervalMs: 6 * 60 * 60 * 1000,
      fireImmediately: true,
      name: 'every-6h',
    }),
  );
};
```

For non-timer triggers, implement the `Trigger<TInput>` interface yourself. See `packages/thread-phase/examples/triggers/{http-adapt,queue-adapt}.ts` for HTTP and queue patterns.

### Adapter

```ts
import { defineAgentAdapter } from '@autonome-research/thread-phase/agents';
import { claudeCodeAgent } from '@autonome-research/thread-phase-agents';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  const adapter = defineAgentAdapter({
    id: 'claude-with-flags',
    capabilities: claudeCodeAgent.capabilities,
    adapter: (config, options) =>
      claudeCodeAgent.adapter(
        { ...config, extraArgs: ['--permission-mode', 'plan'] } as Parameters<typeof claudeCodeAgent.adapter>[0],
        options,
      ),
  });
  api.registerAdapter('claude-with-flags', adapter);
};
```

The `id` is stamped on every emitted `AgentEvent.source` so heterogeneous events stay attributable.

### Pipeline

`PipelineSpec`:

```ts
interface PipelineSpec<TCtx, TInput = unknown> {
  phases: Phase<TCtx>[] | ((input, event) => Phase<TCtx>[]);
  ctx: TCtx | ((input, event) => TCtx);
  trigger?: string;          // bind to a registered trigger
  defaultInput?: TInput;     // used by `thread-phase run`
  description?: string;
}
```

One-shot (no trigger binding):

```ts
api.registerPipeline<MyCtx, void>('summarize-today', {
  phases: [loadInbox, summarize, send],
  ctx: { cache: new PipelineCache(), items: [] },
  description: 'one-off: summarize the inbox',
});
```

Triggered (runs on every fire of the named trigger):

```ts
api.registerPipeline<DigestCtx, void>('morning-digest', {
  phases: [loadQueue, digestEach],
  ctx: () => ({ cache: new PipelineCache(), items: [], digestedIds: [] }),
  trigger: 'morning-timer',
  description: 'fires every 6h',
});
```

Factory form for `ctx` is required when each invocation needs fresh state — otherwise mutations leak between runs.

## CLI commands

```sh
thread-phase list                    # show what's registered
thread-phase run <pipeline-name>     # invoke a pipeline once and exit
thread-phase serve                   # start all triggered pipelines (SIGINT/SIGTERM to stop)
```

`serve` is the cron-host case — one long-running process per project, every triggered pipeline active, backpressure from `runTrigger`'s blocking semaphore.

`run` is the cron-line case — replaces `npx tsx pipelines/foo.ts` with `npx thread-phase run foo` once the pipeline is registered.

## The kernel boundary

These pieces of the core are **not** extension surfaces. Change them only by sending a PR.

- `Phase<TCtx>`, `runPipeline`, `BasePipelineContext`, `PipelineEvent`
- `AgentAdapter`, `AgentRun`, the canonical event vocabulary
- `Thread`, `MemoryProvider` (interfaces only — implementations live in user code or sibling packages)
- `JobStore`, `JobRunner`, `EventBus`
- `Trigger<TInput>` (interface only)

If your extension needs a new kernel primitive, open an issue first. The framework deliberately has a narrow stable surface.

## Where to find examples

- **`examples/.thread-phase/`** — the canonical corpus for the auto-loader. Read these files first; copy and adapt. Includes `lib/poll-until.ts` demonstrating the shared-code convention.
- **`packages/thread-phase/examples/`** — library-only examples (no CLI required).
- **`packages/thread-phase/examples/patterns/`** — `whileCondition`, `match`, `withRetry`.
- **`packages/thread-phase/examples/triggers/`** — HTTP and queue adapters as recipes (not in core).

## Composing pipelines (sub-pipelines)

When multiple registered pipelines share a chunk of work, factor it into its own pipeline and reference it from the outer with `subPipeline`. The CLI exposes `api.getPipeline(name)` for lazy registry lookup so extensions can reference each other regardless of registration order:

```ts
import { PipelineCache } from '@autonome-research/thread-phase';
import { subPipeline } from '@autonome-research/thread-phase/patterns';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<OuterCtx, void>('composed', {
    phases: [
      preStep,
      subPipeline('use-inner', {
        // Lazy: looked up at dispatch time, not registration time.
        pipeline: () => api.getPipeline('inner'),
        mapInput: (outer) => ({ cache: new PipelineCache(), seed: outer.value }),
        mapOutput: (outer, inner) => { outer.result = inner.tally; },
      }),
      postStep,
    ],
    ctx: () => ({ cache: new PipelineCache() }),
  });
};
```

The inner pipeline gets a fresh `PipelineCache` (cache scopes are isolated) but shares the outer's `signal` — so a cancellation flows from the trigger handle through outer → inner. Events from the inner flatten into the outer's stream via `yield*`, so the JobStore log and SSE consumers see one continuous record.

`api.getPipeline` / `getAdapter` / `getTrigger` are also useful when an adapter or trigger extension needs to reference another registered piece (e.g. a custom adapter that wraps the user's claude-code adapter by name).

Working example: `examples/.thread-phase/pipelines/composed.ts` invokes `examples/.thread-phase/pipelines/minimal.ts` via registry lookup.

## Programmatic embedding

The loader and registry can be used without the CLI bin:

```ts
import { Registry, loadExtensions } from '@autonome-research/thread-phase-cli';

const registry = new Registry();
await loadExtensions(registry, { cwd: process.cwd() });

const spec = registry.getPipeline('morning-digest');
const trigger = registry.getTrigger(spec?.trigger ?? '');
// build runTrigger or runPipeline however you want
```

Useful when embedding thread-phase inside a larger runtime (a job queue worker, a Temporal activity, a custom server).
