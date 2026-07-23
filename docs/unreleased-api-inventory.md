# v6.1.0 Stable API Inventory

Baseline: published `@autonome-research/thread-phase@6.0.0`

Repository and package evidence:

- Published v6.0.0 source/tag checkpoint: `dd9f9a739237ee3b47eb74a500ce51a867264e9c`
- Forward-port source checkpoint: `348dcbfc6c3e299d97b80fa8f85524035d90cbe9`
- Published v6.0.0 npm SHA-1: `b61d42ccb6f9d00e2339552b083da82ce9539286`
- Published v6.0.0 tarball SHA-256: `d92cc828ca53b0f90f82ea9b868ee2dd926be4955188e99ea601b1cda29930e4`
- Published v6.0.0 npm integrity: `sha512-WFMo27xxb1fD9FmxoBh2FcrbdH59epZFZhRgJ8V53iFQ9SM4PSk2ssZfTLM4jWqYqvcOV3lQ1P5u7/wLmK2GEg==`
- Published v5.0.0 compatibility fixture: `packages/thread-phase/test-d/fixtures/v5.0.0/published/`

The work was originally reviewed as an unpublished v5.1 candidate. Because v6.0.0 had already been published independently, the additions are forward-ported onto v6 and require the minor release v6.1.0. The historical v5.1 evidence remains archived; it is not a releasable package line.

## Agent event observation

Added stable types:

- `AgentEventHandler`
- `AgentEventHandlerFailure`
- `ObservableAgentEventBus`

Added behavior/surface:

- `createEventBus()` now returns `ObservableAgentEventBus`.
- Factory-created buses expose `onHandlerError(handler)`.
- `AgentEventHandlerFailure` fields are readonly and factory notifications are frozen before observation.
- `@autonome-research/thread-phase-agents` re-exports `AgentEventHandler` and `AgentEventHandlerFailure`.

Compatibility note: the base `AgentEventBus` protocol remains emit/on-only so existing structural implementations remain assignable.

## Bounded AgentEvent persistence

Added stable functions:

- `createAgentEventPersistenceBridge(...)`
- `persistAgentEventsToJobStore(...)`

Added stable types:

- `AgentEventPersistenceBridge`
- `AgentEventPersistenceFailure`
- `AgentEventPersistenceFailureHandler`
- `AgentEventPersistenceFailureKind`
- `AgentEventPersistenceOptions`

Compatibility note: `pipeAgentEventsToJobStore(...)` remains the existing best-effort API. The new bridge is opt-in.

## Lifecycle drains and heartbeat diagnostics

Added stable types/fields:

- `JobRunDrain`
- `JobRunOptions.drains?: ReadonlyArray<JobRunDrain>`
- `JobRunnerOptions.heartbeatTimeoutMs?: number`
- `JobRunnerOptions.onLiveEventError?: (failure: LiveEventListenerFailure) => void | Promise<void>`
- `LiveEventListenerFailure`

Added stable value and methods:

- `JobOwnershipLostError`
- `JobRunner.heartbeatAsOperator(jobId)`
- optional `JobStore.refreshHeartbeat?(jobId, ownerId): Promise<boolean>`
- `SqliteJobStore.refreshHeartbeat(jobId, ownerId): Promise<boolean>` implementation
- `JobListCursor`, `ListJobsPageOptions`, and `CursorJobStore` as an additive cursor capability that leaves the published base `JobStore` contract unchanged
- `SqliteJobStore.listJobsPage(...)` for deterministic bounded continuation of newest-first scans

Compatibility note: `JobRunner.heartbeat(jobId)` remains as a deprecated alias. Existing structural stores remain compatible through one-time `enableHeartbeat()` plus owner-scoped `heartbeat()` fallback; their legacy boolean semantics are not strengthened retroactively.

## Fanout attribution

Added optional public field:

- `BoundedFanoutOfOptions.traceIdFor?: (item, index) => string`

Behavioral contract:

- every per-item ID is derived and validated before config construction or adapter dispatch;
- IDs must be non-empty, Unicode-control-free, and exactly unique;
- existing shared `traceId` behavior remains the default.

This composes with the `skip` and `retryItem` hooks added to `boundedFanout` in v6.0.0.

## Declaration comparison

Compared with the exact published v6.0.0 tarball, generated declaration bytes differ in:

- `agents/event-bus.d.ts`
- `agents/index.d.ts`
- `agents/job-store-bridge.d.ts`
- `agents/protocol.d.ts`
- `index.d.ts`
- `patterns/bounded-fanout-of.d.ts`
- `session/index.d.ts`
- `session/job-runner.d.ts`
- `session/job-store.d.ts`
- `session/sqlite-job-store.d.ts`
- `session/sqlite-driver.d.ts` (internal, non-exported driver adaptation)

No declaration file is missing or newly added relative to the published v6.0.0 package. The internal driver declaration does not determine SemVer; the other differences reconcile with the stable additions above and documentation clarifications.

## Behavioral fixes that are not independently new API

- SQLite opt-in exclusivity and cross-process serialization.
- Migration/schema verification and future-version rejection on the v6 `node:sqlite` backend.
- Serialized, bounded, owner-observable heartbeat supervision.
- Cancellation, heartbeat, pipeline, drain, setup, terminal-write, and completion precedence fixes.
- Isolated snapshot dispatch for live job-event listeners so observer failures cannot affect lifecycle.
- Subscriber throw/rejection isolation.
- Sparse-array fanout attribution correctness.
- Consistent Node.js 22.5+ engine requirements across the locked package set.

## Release verification procedure

1. Build declarations from the exact candidate.
2. Compare every stable package export/subpath against the exact published v6.0.0 tarball.
3. Re-run the immutable published-v5 structural compatibility suite.
4. Classify differences as additive, breaking, behavior-only, internal, or documentation-only.
5. Reconcile declarations with changelogs, migration guidance, and this inventory.
6. Fail release validation if an additive surface is absent here or if a published declaration disappears unexpectedly.
