# Developer Experience and Adoption Roadmap

Status: active planning document for the v5.1 release candidate and subsequent adoption work

thread-phase succeeds only if its lifecycle guarantees are understandable and its failure modes are actionable without reading the implementation. Correctness remains non-negotiable, but developer experience is part of correctness: ambiguous ownership failures, surprising versioning, difficult custom-store conformance, and opaque migration errors all increase adoption risk.

This document records known shortcomings in the current candidate and turns them into an ordered adoption roadmap. It does not authorize merge, publication, tagging, or pushing.

## Release decisions

The current candidate was initially called v5.0.1, but it adds stable public API in four areas:

- event observation (`ObservableAgentEventBus`, handler-failure types, and `onHandlerError`);
- bounded AgentEvent persistence (bridge functions, lifecycle handle, options, and failure types);
- lifecycle control (`JobRunOptions.drains`, `JobRunDrain`, `JobOwnershipLostError`, `heartbeatTimeoutMs`, and `heartbeatAsOperator()`);
- fanout attribution (`boundedFanoutOf.traceIdFor`).

The authoritative symbol-by-symbol list and immutable baseline evidence are in [`unreleased-api-inventory.md`](./unreleased-api-inventory.md). The repository's stability policy defines patch releases as bug fixes with no public API additions. Publishing these additions as 5.0.1 would make the versioning policy unreliable for consumers.

**Decision:** v5.1.0 is approved. The additive API is retained and release metadata is aligned to that minor version.

## Current strengths to preserve

- Runtime-neutral lifecycle authority remains in core.
- Pi sessions, continuation, tools, and TUI remain outside core.
- SQLite exclusivity is explicit and opt-in, not a global pipeline-name lock.
- Cross-process acquisition and ordinary startup serialize safely.
- Ownership loss, heartbeat failure, pipeline failure, drains, cancellation, and completion have defined precedence.
- Published-v5 custom `JobStore` implementations remain structurally compatible.
- Fanout attribution is validated completely before adapter dispatch.
- Future SQLite schema versions and unknown schema collisions fail closed.
- Recovery evidence and canonical master remain untouched.

## Known shortcomings and current workarounds

### 1. Heartbeat capability is compatibility-layered

Published v5 did not define repeated-call boolean semantics for `enableHeartbeat(jobId, ownerId)`, so v5.1 does not reinterpret `false` as ownership loss. Instead, `JobStore.refreshHeartbeat?()` is an additive owner-observable capability.

Current guidance:

- Updated stores should implement repeated `refreshHeartbeat()` calls idempotently: `true` means the same owner refreshed a RUNNING row; `false` means it no longer controls one.
- Published-v5 stores remain compatible through one-time `enableHeartbeat()` plus owner-scoped `heartbeat()` fallback.
- Legacy stores that no-op on owner mismatch cannot provide immediate ownership-loss observation until they adopt the optional capability.
- Explicit `heartbeatEnabled: false` suppresses automatic refresh; manual `ctx.heartbeat()` may opt in later.

Future direction: evolve the optional refresh capability toward a discriminated result and abort signal without changing the published v5 methods.

### 2. Heartbeat timeout cannot cancel store I/O

`heartbeatTimeoutMs` bounds how long `JobRunner` waits, but the Promise-based `JobStore` contract has no abort parameter. A custom backend operation may continue after timeout. Owner-scoped writes prevent it from refreshing a replacement owner, but backend resources still require implementation-level bounds.

Future direction: support an additive signal-aware refresh contract and publish backend-author guidance for deadlines, connection timeouts, and late settlement.

### 3. Manual and automatic refresh may overlap

Automatic attempts are serialized with each other. Manual `ctx.heartbeat()` calls are caller-controlled and may overlap an automatic attempt. This is safe for the bundled idempotent SQLite operation but must be explicit for custom stores.

Future direction: decide whether to serialize all refreshes per run or retain caller-controlled manual concurrency. Add a conformance test for the chosen contract.

### 4. `setRunning()` failure is not diagnostic

The published boolean result cannot distinguish:

- another owner won;
- the row is terminal;
- an active exclusive same-name run blocked startup;
- the row does not exist.

Current behavior fails closed, but hosts cannot produce a precise remediation message without another read.

Future direction: introduce an additive diagnostic claim API returning a stable discriminated outcome while retaining boolean `setRunning()` for compatibility.

### 5. Exclusivity is not visible in `JobRecord`

SQLite persists internal `is_exclusive` policy, but operators cannot see it through `JobRecord`. This makes a blocked ordinary startup harder to explain in dashboards and CLI output.

Future direction: expose runtime-neutral acquisition policy metadata or an inspection API without leaking SQLite schema details.

### 6. Migration verification is intentionally strict and text-sensitive

The SQLite store verifies column and partial-index shape, including normalized SQL predicates. This fails closed, but harmless schema spelling differences may be rejected.

Current guidance: unknown same-named schema objects are not repaired destructively. Error messages identify the conflicting invariant.

Future direction: centralize structural schema inspection, document accepted normalizations, and add a CLI inspection command that reports the exact mismatch before opening a worker.

### 7. Unpublished candidate schemas are intentionally unsupported

**Decision:** collapse the unpublished migration sequence into the single v5.1.0 migration 5. Published v5.0.0 migrations 1–4 remain immutable. Pre-release development databases must be recreated or exported through a published schema rather than carrying permanent candidate-specific repair code.

The release checklist records this as an intentional compatibility boundary, not an accidental omission.

### 8. Trace-ID rules are local to one pattern

`boundedFanoutOf.traceIdFor` currently defines non-empty, control-free, exact-string uniqueness locally. Other adapters and patterns could drift into different rules.

Future direction: publish one shared trace-ID validator/type and use it consistently across fanout, event buses, adapters, and observability integrations. Decide and document whether surrounding whitespace is significant.

### 9. Corrective commit history is useful but noisy

The candidate preserves distinct adversarial fixes, which is valuable evidence. It is less approachable as permanent release history because initial assumptions and their corrections appear sequentially.

Future direction: preserve the current candidate and review artifacts as immutable evidence, then decide whether the final release branch should contain a smaller set of coherent commits. Never rewrite the recovery refs.

## Adoption priorities

### P0 — release preparation

1. Review aligned v5.1.0 package versions, changelogs, migration notes, lockfile, and internal dependency ranges.
2. Run clean-install, build, typecheck, full-test, package-content, tarball-install, and CLI smoke validation.
3. Validate documented supported Node and Pi versions; report unavailable environments as explicit skips.
4. Produce a human release checklist and final integrated review.

### P1 — adoption-critical developer experience

1. **Custom JobStore conformance kit**
   - reusable test suite for ownership, repeated refresh, terminal CAS, stale reconciliation, exclusivity interaction, timeout/late-settlement behavior, and event ordering;
   - reference backend checklist with actionable failure messages.
2. **Lifecycle diagnostics**
   - stable error codes and discriminated outcomes;
   - CLI messages that distinguish ownership, terminal, exclusive-block, migration, and backend failures;
   - document first-cause precedence with race examples.
3. **Runnable lifecycle examples**
   - automatic heartbeat with cancellation;
   - manual opt-in and explicit opt-out;
   - operator recovery override;
   - cross-process exclusive schedule;
   - per-item fanout attribution and event correlation.
4. **Schema inspection UX**
   - read-only command/API reporting schema version and invariant mismatches;
   - upgrade guidance for active runs and future-version databases;
   - no automatic destructive repair for unknown collisions.
5. **Support matrix and CI**
   - clean installs on each supported Node version;
   - package-tarball smoke projects rather than workspace-only imports;
   - optional Pi adapter validation with explicit SDK/runtime requirements.

### P2 — API clarity

1. Add a signal-aware owner refresh operation with a discriminated result.
2. Add a diagnostic job-claim operation while preserving boolean v5 methods.
3. Expose runtime-neutral acquisition-policy metadata for operators.
4. Extract and reuse a shared trace-ID contract.
5. Decide whether all per-run heartbeat calls should share one serializer.
6. Provide structured lifecycle diagnostics suitable for logs, SSE, and host telemetry without adding a mandatory observability dependency.

### P3 — maintenance and test ergonomics

1. Replace multi-second SQLite sleeps with direct fixture timestamps or an injectable clock where this does not weaken integration coverage.
2. Generate authentic migration fixtures from released/candidate package artifacts.
3. Add bounded stress repetitions for exclusive-versus-ordinary process races.
4. Keep migration verification helpers small, structural, and independently tested.
5. Periodically review public barrels so additive exports always trigger a minor-version decision.

## Developer-experience acceptance criteria

A lifecycle feature is not adoption-ready until a developer can answer all of these from public documentation and errors:

1. What operation failed?
2. Was the failure caused by cancellation, ownership loss, exclusivity, terminal state, schema mismatch, timeout, or backend I/O?
3. Did the job reach a durable terminal state?
4. Is retrying safe, unsafe, or host-policy dependent?
5. Which owner and trace ID should be used to correlate events?
6. What configuration or migration action resolves the problem?
7. Does the behavior work for custom stores, or only for bundled SQLite?

## Non-goals

Developer experience work must not turn thread-phase into:

- a distributed scheduler or DAG framework;
- a product UI;
- a mandatory telemetry stack;
- a destructive database repair tool;
- a Pi-specific runtime;
- an unbounded retry engine.

The goal is a small runtime with unusually clear lifecycle behavior, predictable versioning, reproducible packages, and excellent diagnostics.
