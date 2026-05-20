# Extending thread-phase

thread-phase is designed to be modified — by you, or by coding agents working in your project — without forking the core. This document is the map of extension surfaces, the conventions for each, and where to find canonical examples.

> **Status:** the auto-loader and `.thread-phase/<kind>/` discovery conventions described below land in `2.3.0` (CLI + auto-loader). Until then, extensions are imported directly from your application code. The shape of each extension (the contract you fulfil) is stable and works either way.

## The extension surfaces

| Surface | What you write | Where it goes (2.3.0+) | What it does |
|---|---|---|---|
| **Triggers** | An object implementing `Trigger<TInput>` | `.thread-phase/triggers/<name>.ts` | A signal source (timer, webhook adapter, queue consumer, file watcher) that yields events to dispatch pipelines. |
| **Patterns** | A function returning `Phase<TCtx>` or `(phase) => Phase<TCtx>` | `.thread-phase/patterns/<name>.ts` | Reusable control-flow shapes (`whileCondition`, `match`, `withRetry`, custom fanouts, ...). |
| **Adapters** | An object implementing `AgentAdapter` | `.thread-phase/adapters/<name>.ts` | A wrapping of an external agent (a CLI, an SDK, an HTTP API, a custom subprocess) behind the uniform AgentAdapter protocol. |
| **Pipelines** | A `PipelineSpec` ( `{phases, ctx, trigger?}` ) | `.thread-phase/pipelines/<name>.ts` | A named pipeline that `thread-phase run <name>` or `serve` can invoke. |

## The contract

Every extension is a TypeScript file whose default export is a registration function:

```ts
// .thread-phase/triggers/cron-15m.ts
import { TimerTrigger, type ThreadPhaseAPI } from '@autonome-research/thread-phase';

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger('cron-15m', new TimerTrigger({ intervalMs: 15 * 60_000 }));
};
```

Three discovery tiers (in order of complexity):

1. **Loose file** — `.thread-phase/triggers/cron-15m.ts` with a default export.
2. **Folder with `index.ts`** — `.thread-phase/triggers/my-webhook/index.ts` for multi-file extensions.
3. **Folder with `package.json` carrying a `thread-phase` field** — for extensions that need their own dependencies:
   ```json
   {
     "name": "my-webhook",
     "thread-phase": { "extensions": ["./index.ts"] },
     "dependencies": { "fastify": "^4.0.0" }
   }
   ```

Per-extension errors don't fail the whole load. The loader logs the failing extension's path and continues.

## Where to find examples

The `examples/` tree at the repo root is the canonical corpus. When adding a new extension, find the closest match and copy the shape.

```
examples/
  triggers/             ← timer, http-adapt, queue-adapt, file-watch
  patterns/             ← while-condition, match, with-retry, custom fanouts
  adapters/             ← custom-anthropic-flags, claude-code-with-mcp
  pipelines/            ← minimal, bounded-fanout, heterogeneous-chain, cron-digest
```

## The kernel boundary

These pieces of the core are *not* extension surfaces. They're stable substrate — change them only by sending a PR.

- `Phase<TCtx>`, `runPipeline`, `BasePipelineContext`
- `AgentAdapter`, `AgentRun`, the canonical event vocabulary
- `Thread`, `MemoryProvider` (interfaces only — implementations live in user code or sibling packages)
- `JobStore`, `JobRunner`, `EventBus`
- `Trigger<TInput>` (interface only)

If your extension needs a new kernel primitive, open an issue first. The framework deliberately has a narrow stable surface.

## Pre-monorepo extension recipes (interim)

Until the CLI ships in `2.3.0`, you can already build with every extension surface — you just wire them up explicitly in your application code:

```ts
import { runPipeline, JobRunner, SqliteJobStore } from '@autonome-research/thread-phase';
import { boundedFanoutOf, withMemory, withThread } from '@autonome-research/thread-phase';
import { claudeCodeAgent } from '@autonome-research/thread-phase-agents';

// Your pipeline, today:
const runner = new JobRunner(new SqliteJobStore('./jobs.db'));
const jobId = runner.create('my-pipeline', input);
await runner.run(jobId, [phaseA, phaseB], ctx);
```

The auto-loader replaces the boilerplate of "import each extension, wire it manually" with "drop files in a folder, the CLI finds them". The underlying primitives don't change.
