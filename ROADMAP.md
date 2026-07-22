# thread-phase Roadmap

thread-phase is a bounded, runtime-neutral TypeScript execution substrate for deterministic phase structure, agent loops, persistent lifecycle state, cancellation, heartbeat, and concurrency-capped fanout. It is designed to run standalone or inside Temporal, LangGraph, Inngest, and similar orchestrators—not replace them.

Developer experience is part of lifecycle correctness. A safe runtime that cannot explain ownership loss, migration conflicts, version compatibility, or custom-backend requirements is not adoption-ready.

## Active roadmap documents

- [`docs/developer-experience-roadmap.md`](./docs/developer-experience-roadmap.md) — known shortcomings, adoption priorities, future API direction, and DX acceptance criteria.
- [`docs/unreleased-api-inventory.md`](./docs/unreleased-api-inventory.md) — verified stable additions since published v5.0.0 and the release-line decision inventory.
- [`MIGRATING.md`](./MIGRATING.md) — released migration guidance and the current unreleased candidate summary.
- [`packages/thread-phase/CHANGELOG.md`](./packages/thread-phase/CHANGELOG.md) — implemented changes by release.
- [`docs/archive/roadmap-pre-v1.md`](./docs/archive/roadmap-pre-v1.md) — historical pre-v1 roadmap preserved for project context; no longer prescriptive.

## Current candidate

The clean candidate branch contains:

- bounded AgentEvent persistence with deterministic drains;
- hardened subscriber failure observation;
- SQLite opt-in cross-process exclusivity and fail-closed migrations;
- owner-observable, serialized, bounded heartbeat supervision;
- stable prevalidated per-item fanout attribution;
- published-v5 declaration provenance and compatibility tests.

As of the 2026-07-22 checkpoint, the candidate passed build, typecheck, full tests, `git diff --check`, and an integrated low-risk review. Canonical master, merge, push, tag, and publication remain separate decisions.

## P0 — release blockers

1. **Choose the release line.**
   - Recommended: retain additive API and release v5.1.0.
   - Alternative: remove every addition in the stable API inventory and ship a fix-only v5.0.1.
2. **Choose migration-history policy.**
   - Retain compatibility with development-only candidate databases; or
   - collapse unpublished migration history before release and explicitly drop development-database compatibility.
3. **Align release metadata.**
   - root/core/agents/CLI versions;
   - internal dependency ranges and lockfile;
   - changelogs, migration notes, API inventory, and release checklist.
4. **Validate the exact packages.**
   - clean install;
   - build, typecheck, and full tests;
   - package dry-runs and content inspection;
   - isolated local-tarball import and CLI smoke tests;
   - supported Node/Pi matrix with explicit skips;
   - provenance and human release checklist.
5. **Obtain final release-candidate review.**

## P1 — adoption-critical developer experience

1. Publish a reusable custom `JobStore` conformance kit.
2. Add discriminated lifecycle and claim diagnostics without breaking boolean v5 methods.
3. Provide runnable heartbeat, cancellation, exclusivity, operator-recovery, drain, and fanout-attribution examples.
4. Add read-only schema inspection with actionable mismatch and upgrade guidance.
5. Generate stable API diffs from immutable declaration fixtures during release validation.
6. Maintain a tested support matrix based on clean package installs, not only workspace tests.

## P2 — API clarity

1. Add a signal-aware owner-refresh API with a discriminated result; retain `enableHeartbeat()` as a compatibility adapter.
2. Add a diagnostic claim API that distinguishes ownership, terminal, missing-row, and exclusive-block outcomes.
3. Expose runtime-neutral acquisition-policy metadata for operators.
4. Extract a shared trace-ID contract used by fanout, adapters, and observability integrations.
5. Decide whether manual and automatic per-run refreshes should share one serializer.
6. Provide structured diagnostic hooks without adding mandatory telemetry dependencies.

## P3 — maintenance and test ergonomics

1. Replace unnecessary multi-second SQLite sleeps with fixture timestamps or an injectable clock while preserving real integration coverage.
2. Generate authentic migration fixtures from released package artifacts.
3. Add bounded process-race stress tests.
4. Keep schema verification structural, small, and independently tested.
5. Ensure every stable export change triggers an explicit minor-version decision.

## Architectural boundaries

Core owns runtime-neutral lifecycle, persistence contracts, ownership, heartbeat, cancellation, terminal transitions, SSE, and fanout supervision.

Runtime integrations own sessions, continuation delivery, tools, widgets, TUI, and workflow policy. Pi-specific behavior remains in `autonome-pi`.

## Non-goals

thread-phase will not become:

- a distributed DAG scheduler;
- a product UI;
- a JavaScript sandbox;
- a destructive database repair tool;
- a mandatory observability stack;
- a built-in unbounded retry engine.

## Versioning policy

- **patch (x.y.z):** fixes only; no stable API additions.
- **minor (x.y.0):** additive stable API; no breaking changes.
- **major (x.0.0):** breaking changes to stable API.

`@internal` exports are excluded. The stable API inventory and changelog must agree before every release.
