# Migrating from v2.x to v3.0.0

v3.0.0 is a cleanup + simplification release. Breaking changes are listed below with the equivalent v3 form.

## Packaging

`@autonome-research/thread-phase-cli` now depends on `@autonome-research/thread-phase` and `@autonome-research/thread-phase-agents` directly. Installing the CLI gets you the full runtime.

```diff
- npm install @autonome-research/thread-phase @autonome-research/thread-phase-agents @autonome-research/thread-phase-cli
+ npm install @autonome-research/thread-phase-cli
```

**Heavy agent SDKs are optional peer deps** (since v3.0.1). Install only the ones whose adapter you actually use:

```sh
npm install @anthropic-ai/sdk                # for anthropicAgent
npm install openai                           # for codexAgent (Responses API)
npm install @mariozechner/pi-coding-agent    # for piAgent
# claude-code, codex-cli, hermes, openclaw need no SDK (subprocess-based).
```

If you call an adapter whose SDK isn't installed, you get a clear `... requires the optional peer dep <pkg>. Install it with: npm install <pkg>` error rather than a missing-module crash at startup.

Library-only users (no CLI, no auto-loader) keep installing the core directly:

```sh
npm install @autonome-research/thread-phase
# optionally, for adapters:
npm install @autonome-research/thread-phase-agents
```

## JobStore is async

Every method on `JobStore` returns a Promise. `SqliteJobStore` wraps its sync `better-sqlite3` calls in `Promise.resolve(...)`; performance is unchanged.

```diff
- const jobId = store.createJob('my-pipeline', input);
- const events = store.getEvents(jobId, afterId);
+ const jobId = await store.createJob('my-pipeline', input);
+ const events = await store.getEvents(jobId, afterId);
```

`JobRunner.run` was already async; no signature change there beyond the internal `await`s.

If you have a custom `JobStore` implementation, change every method signature to return a Promise. The sync version is gone.

## Patterns trimmed (12 → 7)

Five narrow specializations of more general patterns have been deleted from the public API. Each has a documented recipe in [`packages/thread-phase/docs/recipes.md`](packages/thread-phase/docs/recipes.md):

| Deleted | Replacement |
|---|---|
| `parallelFanout` | `Promise.all` |
| `streamingBoundedFanout` | `boundedFanout` with `for await` over its result iterator |
| `preflightConfidence` | `intentGate` with a scoring classifier |
| `spotCheck` | `boundedFanout` over a sampled subset |
| `synthesizeWithFollowup` | `whileCondition` with the synthesizer + critic in the body |

Imports of the deleted patterns will fail at type-check time. See `docs/recipes.md` for copy-paste equivalents.

## New convenience helpers

For one-shot automations, simple cron jobs, and webhooks, three new helpers compress the common case to one function call:

```ts
import { schedule, hook, oneShot } from '@autonome-research/thread-phase';

// Cron
export default schedule({ intervalMs: 6 * 60 * 60 * 1000 }, async (ctx) => {
  await doStuff();
});

// Webhook
export default hook({ path: '/digest' }, async (payload, ctx) => {
  return { ok: true };
});

// One-shot — `thread-phase run <name>`
export default oneShot(async (ctx) => {
  await fireAndForget();
});
```

These are additive. Existing `registerPipeline` + `registerTrigger` code keeps working.

## Other cleanups

- **`PipelineEvent.error`** is now only emitted by `JobRunner` for the event log — `runPipeline` never yields it. The JSDoc says so. No code change for callers who already migrated to the v2.4 throw-based contract.
- **`subPipelineOf`** is a new typed convenience wrapper around `subPipeline` for the direct-source case. The inner ctx type is inferred. Old `subPipeline<TOuter, TInner>` still works.
- **Signal layering** — `ctx.signal`, `RunTriggerHandle.cancel`, `JobRunner.cancel`, and adapter `AbortSignal` are now documented as one unified cancellation story in `packages/thread-phase/docs/cancellation.md`.

## Step-by-step

1. `npm install @autonome-research/thread-phase-cli@^3.0.0`
2. If you have a custom `JobStore` impl: change every method to return a Promise.
3. If you imported any deleted pattern: replace per the recipes table above.
4. If you wrote a cron / webhook by hand: optionally rewrite using `schedule` / `hook`. The old form still works.

## Questions

Open an issue on `github.com/autonome-research/thread-phase` if a v2 → v3 migration step isn't covered.
