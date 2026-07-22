# Unreleased Stable API Inventory

Baseline: published `@autonome-research/thread-phase@5.0.0`

Repository evidence:

- Published declaration fixture: `packages/thread-phase/test-d/fixtures/v5.0.0/published/`
- Fixture provenance: `packages/thread-phase/test-d/fixtures/v5.0.0/provenance.json`
- Published-contract restoration checkpoint: `942df3e804d7301d2897e2f429ee284a99de137e`
- Current candidate checkpoint when this inventory was reviewed: `512742741c8a0e9c31b3ae61e095be1656bbc860`

This inventory records the evidence for the approved v5.1.0 release line. It lists stable additive surfaces, not internal implementation changes. Retaining these additions requires a minor release; v5.1.0 was selected rather than removing them for a fix-only v5.0.1.

## Agent event observation

Added stable types:

- `AgentEventHandler`
- `AgentEventHandlerFailure`
- `ObservableAgentEventBus`

Added behavior/surface:

- `createEventBus()` now returns `ObservableAgentEventBus`.
- Factory-created buses expose `onHandlerError(handler)`.
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

## JobRunner lifecycle additions

Added stable export/type:

- `JobRunDrain`

Added optional public field:

- `JobRunOptions.drains?: ReadonlyArray<JobRunDrain>`

Added stable value/type:

- `JobOwnershipLostError`

Added optional public field:

- `JobRunnerOptions.heartbeatTimeoutMs?: number`

Added public method:

- `JobRunner.heartbeatAsOperator(jobId)`

Compatibility note: `JobRunner.heartbeat(jobId)` remains as a deprecated alias. Automatic and manual owner-sensitive refresh use the already-published `enableHeartbeat(jobId, ownerId): Promise<boolean>` contract.

## Fanout attribution

Added optional public field:

- `BoundedFanoutOfOptions.traceIdFor?: (item, index) => string`

Behavioral contract:

- every per-item ID is derived and validated before config construction or adapter dispatch;
- IDs must be non-empty, control-free, and exactly unique;
- existing shared `traceId` behavior remains the default.

## Important behavioral fixes that are not themselves new API

These affect release notes and migration guidance but do not independently determine patch versus minor:

- SQLite opt-in exclusivity and cross-process serialization.
- SQLite migration/schema verification and future-version rejection.
- Serialized, bounded, owner-observable automatic heartbeat supervision.
- Cancellation, heartbeat, pipeline, drain, and completion precedence fixes.
- Subscriber throw/rejection isolation on event buses.
- Sparse-array fanout attribution correctness.
- Dependency/runtime upgrades already recorded in the changelog.

## Verification procedure

Before release, regenerate and review this inventory from declarations rather than relying only on prose:

1. Build declarations from the exact candidate.
2. Compare every stable package export/subpath against `test-d/fixtures/v5.0.0/published/`.
3. Classify differences as additive, breaking, behavior-only, internal, or documentation-only.
4. Reconcile the result with `[Unreleased]` changelogs for core, agents, and CLI.
5. Fail release validation if any stable additive surface is absent from this inventory and the release checklist.

Planned DX automation: add a declaration/API comparison report to release CI so future version-line decisions are generated from immutable package evidence.
