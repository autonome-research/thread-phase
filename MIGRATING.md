# Migrating from v5.0.0 to v5.1.0

v5.1.0 is additive at the TypeScript API boundary and retains the published v5.0.0 `JobStore` contract. The complete stable API inventory is maintained in [`docs/unreleased-api-inventory.md`](./docs/unreleased-api-inventory.md).

Consumer-facing behavior:

- bundled SQLite and updated custom stores can implement optional `refreshHeartbeat(jobId, ownerId)` for owner-observable repeated refresh; published-v5 stores fall back to one-time `enableHeartbeat()` plus owner-scoped `heartbeat()` without imposing new meaning on the legacy boolean result;
- `heartbeatEnabled: false` suppresses automatic refresh for that run, while manual `ctx.heartbeat()` can opt in later;
- SQLite exclusivity is opt-in through `acquireExclusive()`: ordinary same-name runs may overlap each other, but cannot overlap an active exclusive run;
- `traceIdFor(item, index)` derives unique per-item attribution before any adapter dispatch;
- future or incompatible SQLite schemas fail closed with an actionable error.

## SQLite schema migration

Published v5.0.0 databases end at schema version 4. v5.1.0 applies one transactional migration to schema version 5, adding the constrained `is_exclusive` flag and its verified partial unique index. Existing rows remain ordinary, non-exclusive rows.

Unpublished development candidate schemas were deliberately collapsed before release and are not supported. If a local database was opened by a pre-release candidate, delete/recreate it or export the data into a published v5.0.0 schema before opening it with v5.1.0. Schema versions newer than 5 fail closed without automatic repair.

---

# Migrating from v4.1.x to v5.0.0

v5 makes the persisted run lifecycle authoritative and safe for workflow hosts deploying deterministic subagents.

## Custom JobStore implementations

`JobStore` now requires:

- atomic owner claiming through boolean `setRunning(...)`
- owner-aware heartbeat and terminal transitions, including atomic `enableHeartbeat(...)`
- distinct `CANCELLED` and `ABANDONED` statuses
- `setAbandonedIfStale(...)`
- atomic `finalizeJob(...)` and `finalizeAbandonedIfStale(...)`, which commit terminal state and terminal event together

Terminal setters return `boolean`; `false` means another owner or terminal transition won. Copy the SQLite implementation's first-writer-wins conditions when adapting another backend.

## JobRunner

- `JobRunner.start(...)` returns `{ jobId, signal, cancel, result }` immediately.
- The runner automatically composes and installs `ctx.signal`.
- Cancellation persists `cancellation_requested` followed by atomic `CANCELLED` + `cancelled` terminal state/event.
- `reconcileAbandoned(...)` atomically verifies the heartbeat cutoff and owner identity.
- Automatic staleness is opt-in through `heartbeatMs`; calling manual `ctx.heartbeat()` opts the run in on first use.

## Fanout and SSE

- Invalid concurrency now throws instead of clamping unsafe values.
- Fail-fast fanout aborts and awaits active siblings before rejecting.
- `SSEResponse` now requires `off('close', listener)` in addition to `on` and `once`, allowing backpressure cleanup without listener leaks.

The SQLite schema migration is automatic and additive. Existing PENDING/RUNNING/COMPLETED/FAILED rows remain readable.

## Pi adapter SDK rename

The optional `piAgent` SDK moved from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent`. Replace the old package when using the adapter:

```bash
npm uninstall @mariozechner/pi-coding-agent
npm install @earendil-works/pi-coding-agent
```

The current Pi SDK requires Node.js 22.19.0 or newer; the rest of thread-phase retains its broader Node engine support.

---

# Migrating from v4.0.x to v4.1.0

v4.1.0 is **purely additive**. Nothing breaks. You can upgrade without changing any code.

What landed:
- `JobRunner` gains `heartbeatMs` constructor option + `JobRunner.heartbeat(jobId)` method + `ctx.heartbeat?.()` exposure
- `JobRecord` gains optional `sessionId`, `pid`, `ppid`, `cwd`, `hostname`, `heartbeatAt` fields
- `JobStore.getJob(jobId, {staleAfterMs})` and `JobStore.listJobs({staleAfterMs, status: 'STALE'})` for read-time staleness detection
- `Phase.checkpointKey?: string` for skip-on-resume marking
- `RunPipelineOptions.resume?: { completedKeys }` for executing only the not-yet-completed checkpointed phases
- `completedCheckpointsFromEvents(events)` helper for deriving `completedKeys` from a prior run's event log
- `{type: 'phase_complete', phase, checkpointKey}` added to the `PipelineEvent` union — emitted after each checkpointed phase finishes cleanly
- `superviseChild` exported from `@autonome-research/thread-phase/agents/authoring` — child-process lifecycle helper for subprocess-based adapter authors

If you don't use `JobRunner` (you call `runPipeline` directly or only use the convenience helpers without persistence), these additions don't affect you. Your existing `JobRecord` rows continue to work — the new columns are nullable and the read path treats them as `undefined`.

If you DO use `JobRunner`, opt into durability by:

```typescript
// Enable automatic heartbeat
const runner = new JobRunner(store, { heartbeatMs: 15_000 });

// In an operator script, detect dead runs
const dead = await store.listJobs({ status: 'STALE', staleAfterMs: 60_000 });
```

The `SqliteJobStore` schema migration runs automatically the first time a v4.1.0+ process opens an existing v4.0.x database. The migration is additive (ALTER TABLE ADD COLUMN) and reversible only by dropping the new columns manually if you need to downgrade.

---

# Migrating from v3.x to v4.0.0

v4.0.0 commits the `/agents` subpath to semver stability and moves the adapter-author helpers to a separate `thread-phase/agents/authoring` subpath. The split codifies the existing prose-comment-based boundary as two physical import paths.

**You are unaffected if:**
- You import only from `@autonome-research/thread-phase`, `@autonome-research/thread-phase/patterns`, `@autonome-research/thread-phase/triggers`, etc.
- You import only from `@autonome-research/thread-phase-agents` (the sibling package)
- You import the protocol TYPES (`AgentAdapter`, `AgentRun`, `AgentRunResult`, `AgentEvent`, etc.) or consumer-facing primitives (`createEventBus`, `withMemory`, `withThread`, `pipeAgentEventsToJobStore`, `createThread`, …) from `@autonome-research/thread-phase/agents`

**You need to update one import if:**
- You import any of the following from `@autonome-research/thread-phase/agents`:
  - `composeAbort`, `CompositeAbort`, `createEventQueue`, `EventQueue`, `lazyEvents`
  - `TurnAccumulator`
  - `serializeError`
  - `applyStructuredOutputPrompt`, `extractResponseBlock`, `parseStructuredFromText`, `parseStructured`
  - `AgentCapabilityError`, `requireCapability`

For each of those, change the import path from `'@autonome-research/thread-phase/agents'` to `'@autonome-research/thread-phase/agents/authoring'`. The names themselves are unchanged.

```diff
- import { composeAbort, TurnAccumulator } from '@autonome-research/thread-phase/agents';
+ import { composeAbort, TurnAccumulator } from '@autonome-research/thread-phase/agents/authoring';
```

If your file imports a mix of Tier A and Tier B names from the old path, split the import into two:

```diff
- import {
-   defineAgentAdapter,
-   composeAbort,
-   TurnAccumulator,
-   serializeError,
-   type AgentRunResult,
- } from '@autonome-research/thread-phase/agents';
+ import {
+   defineAgentAdapter,
+   type AgentRunResult,
+ } from '@autonome-research/thread-phase/agents';
+ import {
+   composeAbort,
+   TurnAccumulator,
+   serializeError,
+ } from '@autonome-research/thread-phase/agents/authoring';
```

See `STABILITY.md` at the repo root for the full tier policy and the semver commitments going forward.

---

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
npm install @earendil-works/pi-coding-agent    # for piAgent
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
