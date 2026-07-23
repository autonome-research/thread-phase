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

At validated code/package checkpoint `f24d28a`, the candidate passed clean-install build, typecheck, full tests, `git diff --check`, production audit, package inspection, and exact-tarball smoke tests on Node 20, 22, and 26. The final full-range review through evidence checkpoint `a16e253` returned a low-risk verdict with no critical findings. Canonical master, merge, tag, and publication remain separate decisions.

## P0 — release preparation

Resolved release decisions:

- v5.1.0 is the approved release line.
- unpublished candidate migrations are collapsed into the single v5.1.0 migration 5; development candidate databases are intentionally unsupported.

Completed release preparation:

- aligned root/core/agents/CLI versions, internal ranges, lockfile, changelogs, migration notes, API inventory, and release checklist;
- validated clean installs, build, typecheck, full tests, package contents, exact tarballs, SQLite, CLI, supported Node 20/22/26 runtimes, and the Pi adapter;
- preserved exact package artifacts and hashes outside git for the validated checkpoint.

Remaining release work:

1. Confirm candidate cleanliness and canonical-master isolation.
2. Push the reviewed candidate branch under the explicit approval already granted.
3. Obtain separate human decisions for merge, tag, and publication.

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
6. Snapshot persistence-failure observers so callback-time subscription changes affect only later notifications.
7. Strengthen stale-reconciliation pagination when the first listed page changes before conditional finalization.
8. Expand clean-install CI across every Node line claimed by package `engines`.

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
