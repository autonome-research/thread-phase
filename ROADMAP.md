# thread-phase Roadmap

thread-phase is a bounded, runtime-neutral TypeScript execution substrate for deterministic phase structure, agent loops, persistent lifecycle state, cancellation, heartbeat, and concurrency-capped fanout. It is designed to run standalone or inside Temporal, LangGraph, Inngest, and similar orchestrators—not replace them.

Developer experience is part of lifecycle correctness. A safe runtime that cannot explain ownership loss, migration conflicts, version compatibility, or custom-backend requirements is not adoption-ready.

## Active roadmap documents

- [`docs/developer-experience-roadmap.md`](./docs/developer-experience-roadmap.md) — known shortcomings, adoption priorities, future API direction, and DX acceptance criteria.
- [`docs/unreleased-api-inventory.md`](./docs/unreleased-api-inventory.md) — verified stable additions that shipped in published v6.1.0 (relative to published v6.0.0) and release-line evidence.
- [`MIGRATING.md`](./MIGRATING.md) — released migration guidance for the current published line.
- [`packages/thread-phase/CHANGELOG.md`](./packages/thread-phase/CHANGELOG.md) — implemented changes by release.
- [`docs/archive/roadmap-pre-v1.md`](./docs/archive/roadmap-pre-v1.md) — historical pre-v1 roadmap preserved for project context; no longer prescriptive.

## Current published line

**v6.1.0 is published.** `@autonome-research/thread-phase@6.1.0` is on npm, `packages/thread-phase/package.json` is `6.1.0`, and git tag `v6.1.0` exists. It is not a candidate.

Published v6.1.0 includes:

- bounded AgentEvent persistence with deterministic drains;
- hardened subscriber failure observation;
- SQLite opt-in cross-process exclusivity and fail-closed migrations;
- owner-observable, serialized, bounded heartbeat supervision;
- stable prevalidated per-item fanout attribution;
- published-v5 declaration provenance and compatibility tests;
- the v6.0 `node:sqlite`, `boundedFanout` skip/retry, and `oneShot` input behavior.

The original v5.1 candidate was validated and reviewed but never published. Remote `master` had already advanced to published v6.0.0, so that work was forward-ported onto `dd9f9a7` and shipped as v6.1.0.

## P0 — v6.1.0 release status

Completed:

- v6.1.0 is the published release line (npm package and git tag).
- unpublished candidate migrations remain collapsed into the single migration 5; development candidate databases are intentionally unsupported.
- all locked packages require Node.js 22.5 or newer because core v6 uses `node:sqlite`.
- forward-port merge, tag `v6.1.0`, and npm publication are done.

Remaining P0 merge/tag/publication work from the candidate era is finished. GitHub Releases is still empty despite existing tags; that is tracked separately in #8 and does not make 6.1.0 unpublished.

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
