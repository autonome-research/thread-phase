# Stability policy

> Applies to `@autonome-research/thread-phase`, `@autonome-research/thread-phase-agents`, and `@autonome-research/thread-phase-cli` from v4.0.0 onward.

## Two modes

thread-phase ships two modes of use, both supported and stable:

1. **Agent-loop mode** — thread-phase is the inner `runAgentWithTools` + pipeline composition layer inside an outer workflow runtime (Temporal, Inngest, LangGraph). The outer runtime handles durability, heartbeat, supervision, retry, and observability. You consume thread-phase via the library imports; you do NOT use `JobRunner` or `JobStore`.
2. **Primary-runtime mode** — thread-phase IS the workflow runner. You drive pipelines via `oneShot`, `schedule`, `hook`, or directly via `JobRunner.run`. Durability comes from `SqliteJobStore` + heartbeat + ownership metadata + checkpoint/resume. This is a single-node SQLite runtime by deliberate choice. Multiple local processes sharing one database can coordinate opt-in exclusive acquisition, but thread-phase is not a distributed workflow runtime; for distributed workflow shapes, use mode 1 instead.

Primary-runtime mode landed as a coherent feature set in v4.1.0:
- `JobRunner` heartbeat option (`heartbeatMs`) + `ctx.heartbeat?.()` for manual phase-level liveness
- `JobRecord` ownership metadata (`sessionId`, `pid`, `ppid`, `cwd`, `hostname`, `heartbeatAt`) auto-populated at `setRunning`
- `JobStore.getJob` / `listJobs` accept `staleAfterMs` for read-time staleness detection (status: `'STALE'`)
- `Phase.checkpointKey` + `RunPipelineOptions.resume.completedKeys` for linear skip-on-resume
- `superviseChild` in `thread-phase/agents/authoring` for subprocess-based adapter lifecycle

The framework deliberately does NOT ship: a bundled distributed JobStore (Postgres/Redis), distributed orchestration or consensus, sweeper / reaper processes, ctx/Thread/Memory state restoration on resume, DAG-shaped checkpoint resume, or built-in observability beyond the event log. SQLite does provide bounded cross-process coordination for migration and opt-in exclusive acquisition when those processes share the same local database.

## Two tiers in the `/agents` subpath

The AgentAdapter protocol surface is split across two subpaths with different stability guarantees:

| Subpath | Tier | Stability |
|---|---|---|
| `@autonome-research/thread-phase/agents` | **Tier A** | Stable — covered by semver |
| `@autonome-research/thread-phase/agents/authoring` | **Tier B** | Unstable — may change in any minor release |

**Anyone using or composing pre-built adapters** (`claudeCodeAgent`, `codexAgent`, `hermesAgent`, etc.) imports from `thread-phase/agents` or transitively via `thread-phase-agents`. They get full semver coverage.

**Anyone writing a new AgentAdapter from scratch** also imports from `thread-phase/agents/authoring` to get implementation helpers (`composeAbort`, `createEventQueue`, `lazyEvents`, `TurnAccumulator`, `serializeError`, prompted structured-output helpers, `requireCapability`). These are useful but they're where API churn happens — pin your `@autonome-research/thread-phase` version exactly if you depend on them.

## What lives in each tier

### Tier A — `thread-phase/agents` (stable)

Consumer-facing types and decorators that have stabilized across multiple minor cycles.

**Protocol types (from `protocol.ts`):**
`AgentAdapter`, `AgentAdapterMeta`, `AgentCapabilities`, `AgentEvent`, `AgentEventBus`, `ObservableAgentEventBus`, `AgentEventHandler`, `AgentEventHandlerFailure`, `AgentFinishReason`, `AgentRun`, `AgentRunOptions`, `AgentRunResult`, `ResumeToken`, `SerializableError`, `SteerableAgentRun`, `defineAgentAdapter`, `isSteerable`

**Composition primitives:**
`createEventBus`, `pipeAgentEventsToJobStore`, `PipeAgentEventsOptions`, `createAgentEventPersistenceBridge`, `persistAgentEventsToJobStore`, `AgentEventPersistenceBridge`, `AgentEventPersistenceFailure`, `AgentEventPersistenceFailureHandler`, `AgentEventPersistenceFailureKind`, `AgentEventPersistenceOptions`

**Thread state:**
`Thread`, `createThread`, `appendEvent`, `resumeTokenFor`, `setResumeToken`, `threadToMessages`

**Memory state:**
`MemoryProvider`, `MemoryScope`

**Adapter decorators:**
`withMemory`, `WithMemoryOptions`, `withThread`, `WithThreadOptions`

**Structured-output TYPES:**
`StructuredOutputConfig`, `StructuredOutputParseError`

**Reference adapter:**
`inferenceAgent`, `InferenceAgentConfig`

### Tier B — `thread-phase/agents/authoring` (unstable)

Implementation helpers for adapter AUTHORS. These shapes may change in any minor release.

**Composition primitives:**
`composeAbort`, `CompositeAbort`, `createEventQueue`, `EventQueue`, `lazyEvents`

**Turn-boundary helper:**
`TurnAccumulator`

**Error normalization:**
`serializeError`

**Prompted structured-output runtime:**
`applyStructuredOutputPrompt`, `extractResponseBlock`, `parseStructuredFromText`, `parseStructured`

**Capability validation:**
`AgentCapabilityError`, `requireCapability`

## When can Tier A change?

Following standard semver:

- **patch** (`4.0.x`): bug fixes, no API changes
- **minor** (`4.x.0`): additive — new exports, new optional fields, behavioral improvements that don't change observable contracts
- **major** (`x.0.0`): breaking changes, always with a migration note in `MIGRATING.md`

## When can Tier B change?

Anytime. Tier B carries no semver commitment — the unstable subpath is the explicit escape valve so the protocol can evolve without forcing major-version cadence on every helper refactor.

Concretely: a Tier B export may change shape, be renamed, or be removed in any minor release. The CHANGELOG will note breaking Tier B changes but they won't trigger a major.

If you depend on a Tier B export and the churn is painful, the right move is to fork or vendor the helper — it's stable enough at any given point in time, it's just not committed to staying that way across releases.

## Promotion path (Tier B → Tier A)

A Tier B export earns Tier A promotion when:

1. It has shipped without breaking changes for at least two minor releases
2. It has consumer-side use cases beyond just "implementation detail of bundled adapters" — i.e., real signal that external code wants to import it directly
3. Its design has been validated against at least one out-of-tree adapter (real-world stress test of the boundary)

Promotion happens in a minor release: the export moves from the `/authoring` barrel to `/agents`, with a corresponding deprecated re-export from `/authoring` for one minor cycle.

`parseStructuredFromText` is the current strongest promotion candidate — six bundled adapters use it. If consumer-facing structured-output re-parsing becomes a documented use case, it would graduate.

## Demotion path (Tier A → Tier B)

A Tier A export gets demoted to Tier B only at a major bump — and only after concrete evidence that the design is wrong (not just suboptimal). The migration note explains the reasoning.

## Beyond the `/agents` subpath

These tier rules cover only the `/agents` subpath split. The other public surfaces have their own implicit policies:

- `@autonome-research/thread-phase` main entry (`.`): all stable from v3.0.0 onward. Same semver rules as Tier A above.
- `@autonome-research/thread-phase/patterns`: all stable. `boundedFanoutOf` was promoted in v3.3.2.
- `@autonome-research/thread-phase/triggers`, `/context`, `/session`, `/tools`: all stable.
- `@autonome-research/thread-phase/agents/test-utils`: explicitly testing-only; mock adapter shapes may change as the test-utils surface evolves.
- `@autonome-research/thread-phase-agents`: every named adapter export (`claudeCodeAgent`, `codexAgent`, etc.) is stable. The thread-bridge helpers and injectors are stable. Some internal adapter implementation details remain `@internal` — those are noted at the export site.
