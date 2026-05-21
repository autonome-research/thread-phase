# Changelog

All notable changes to thread-phase will be documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project follows [Semantic Versioning](https://semver.org/) starting at v1.0.0. Pre-v1, breaking changes may land in any release — read these notes before upgrading.

## [Unreleased]

## [3.2.0] — 2026-05-21

Docs-only release for core. Real changes ship in `@autonome-research/thread-phase-cli@3.2.0` (init command, walk-up discovery, load summary, --strict).

### Documentation

- **AGENTS.md / SKILL.md**: added an "Import-path map" section as single source of truth for which symbol comes from which package/subpath. Plus a "Common deps for phase code" callout listing `execa`, `node:fs`, `fetch`, etc. + the `execa` v9 non-zero-exit gotcha.
- **README.md**: docs index entry expanded to mention the `thread-phase.extensions` manifest format.
- **EXTENDING.md**: TL;DR now points at `thread-phase init` as the quickest start and forward-references the manifest format.
- Pi-local skill at `~/.pi/agent/skills/thread-phase/SKILL.md` synced.

## [3.1.0] — 2026-05-21

Docs-only release for core; the change of substance is in `@autonome-research/thread-phase-agents@3.1.0` (re-export of the consumer + chain-builder surface so callers using adapters import from one place).

### Documentation

- **AGENTS.md**: three new sections after the Quickstart — "Building multi-phase pipelines", "Injecting code between stages", "Implementing loops". Each covers the gap between the helpers (single-function automations) and the full Phase template (deep multi-agent chains).
  - Pipelines: the Phase model, `requireCtx` for loud failure, mutate-ctx / yield-events rule.
  - Injecting: array editing for the simple case; `match` / `intentGate` / `parallelPhases` / `withRetry` / `subPipeline` for less-trivial cases.
  - Loops: three patterns (plain `while` in helper, `whileCondition` pattern, `withRetry` wrapper) with a decision table.
- **SKILL.md**: mirror of the new sections.
- Pi-local skill at `~/.pi/agent/skills/thread-phase/SKILL.md` synced.

## [3.0.3] — 2026-05-21

Docs only — agent-facing. Pre-3.0.3, agents reading AGENTS.md / SKILL.md were led directly to the full Phase + `registerPipeline` template, ignoring the convenience helpers shipped in v3.0.0. Coding agents (pi, claude-code, codex) consistently wrote 30-50 lines for what `schedule()` now handles in 5.

### Documentation

- **AGENTS.md**: added a "Quickstart — convenience helpers" section right after TL;DR. Leads with `oneShot` / `schedule` / `hook` as the first recommendation for any "simple automation" request, with a decision-rule table mapping common user requests to the right primitive.
- **SKILL.md**: mirror change. Header refreshed to the v3 install command (single `npm install -g @autonome-research/thread-phase-cli`) and the three-package monorepo structure.
- Pi-local skill at `~/.pi/agent/skills/thread-phase/SKILL.md` synced.

## [3.0.2] — 2026-05-20

Locked-version release in step with `@autonome-research/thread-phase-cli@3.0.2` (`--version` flag + empty-list hint). No core changes.

## [3.0.1] — 2026-05-20

Locked-version release in step with `@autonome-research/thread-phase-agents@3.0.1` (heavy agent SDKs moved to optional peer deps; pi-coding-agent, anthropic-sdk, openai@6 no longer pulled in by default). No core changes.

## [3.0.0] — 2026-05-20

### Breaking — `JobStore` is async by default

Every method on the `JobStore` interface now returns a `Promise`:

```ts
// v2 (sync) ⇒ v3 (async)
createJob(name, input)        : string           → Promise<string>
acquireExclusive(name, input) : string | null    → Promise<string | null>
setRunning(jobId)             : void             → Promise<void>
setCompleted(jobId, result)   : void             → Promise<void>
setFailed(jobId, error)       : void             → Promise<void>
appendEvent(jobId, event)     : number           → Promise<number>
getJob(jobId)                 : JobRecord | null → Promise<JobRecord | null>
listJobs(options?)            : JobRecord[]      → Promise<JobRecord[]>
getEvents(jobId, afterId?)    : EventRecord[]    → Promise<EventRecord[]>
close()                       : void             → void | Promise<void>
```

`close()` accepts either sync or async return — closing isn't a perf-sensitive path and embedded backends (sqlite, in-memory) can stay sync.

Why: the prior sync interface blocked any backend whose underlying I/O is async (Postgres, Redis, network-attached stores). Custom implementations had to fake a sync boundary via in-process queues, which gave eventual consistency for events that callers couldn't easily reason about. Going async at the interface level unblocks those backends.

Performance: the bundled `SqliteJobStore` wraps its sync `better-sqlite3` calls in `async` methods. better-sqlite3 stays sync internally; the only overhead is one microtask per call — sub-microsecond, swamped by the actual I/O on any other backend, and negligible against sqlite's prior sub-millisecond write cost.

### Migration

User code that touched a `JobStore` directly needs `await` on every call:

```ts
// Before
const id = store.createJob('p', input);
const job = store.getJob(id);
const events = store.getEvents(id);

// After
const id = await store.createJob('p', input);
const job = await store.getJob(id);
const events = await store.getEvents(id);
```

`JobRunner` and `streamToSSE` handle this internally — pipeline code that goes through them needs no changes. `JobRunner.create(name, input)` now returns `Promise<string>` (previously `string`); any direct call site needs `await`.

Custom `JobStore` implementations must change their method signatures from sync to `async` (returning a `Promise`). The simplest port: prefix each method with `async`, leave the body as-is. The interface accepts that — `async` methods auto-wrap return values in a Promise, so no body changes are needed for sync-backed stores.

`pipeAgentEventsToJobStore` (the agent-event-bus → JobStore bridge) keeps its existing fire-and-forget semantics: bus emit is sync, the bridge schedules the async append as a microtask and swallows rejections. Tests that read back from the store after emitting events now need a microtask flush before the read.

## [2.5.0] — 2026-05-20

Sub-pipeline composition. The substrate now has a clean primitive for composing pipelines without copying phase arrays.

### Added

- **`subPipeline(name, options)`** (`@autonome-research/thread-phase/patterns`) — higher-order pattern returning a `Phase<TOuterCtx>` that runs an inner pipeline as a step. The inner gets a fresh `PipelineCache` (isolated scope); the outer's `signal` propagates down (cancellation flows); the inner's events flatten into the outer's stream via `yield*`. Optional `mapInput: (outer) => inner` and `mapOutput: (outer, inner) => void` for explicit ctx shaping. The `pipeline` option accepts either a direct `{ phases, ctx }` object or a lazy resolver (so the CLI can do registry-by-name lookup without core depending on the Registry).
- **`runSubPipeline(source, options?)`** — imperative form for use inside a phase body. Returns `{ ctx, summary }`. Same isolation semantics.
- **Types**: `SubPipelineOptions`, `SubPipelineSource`.

### Notes

- Inner pipeline failures (phase throws) propagate to the outer's iteration, which `runPipeline` re-throws — same as any other phase exception.
- Cycle detection is the caller's responsibility (e.g. a counter in ctx). Unbounded recursion is undefined behavior.
- 9 new tests; 299 in the core package.

## [2.4.0] — 2026-05-20

Cleanup pass addressing the post-2.3 review (problems 1, 4, 9 from the review). Breaking on the error and cancellation contracts; clean separation of concerns is the new state.

### Breaking — error model

- **`runPipeline` no longer catches phase exceptions.** Phase throws propagate to the for-await consumer (or to `runPipelineToSummary`'s promise rejection). The `error` event type on `PipelineEvent` is now only synthesized by `JobRunner` for the persistent event log; live consumers of `runPipeline` directly should `try` around the for-await loop.
- **`JobRunner.run` returns `Promise<PipelineSummary>` and rejects on failure.** Previously returned `Promise<void>` and silently set job status. Phase exceptions now reject with the original error (after `setFailed` + synthesized error event have been written + emitted); cancellation rejects with an `AbortError`-shaped Error (`name === 'AbortError'`).
- **`runTrigger` drops the `jobStore` option.** No longer needed — the runner reports failure through its rejection, so `runTrigger` uses simple try/catch around dispatch.

### Added — orchestrator

- **`PipelineSummary`** type — terminal state of a pipeline run, `{ status: 'completed' | 'stopped', reason?, eventCount }`.
- **`runPipelineToSummary(phases, ctx, options?)`** helper — consumes the generator and resolves with the summary. Phase exceptions reject the promise.
- **`runPipeline(phases, ctx, options?)`** now accepts `{ signal }`. The signal is checked between phases; aborting throws an `AbortError`. Mid-phase observation is the phase's responsibility (e.g. via `ctx.signal`).

### Added — cancellation + observability (problem 4 + 9)

- **`BasePipelineContext.signal?`** — optional AbortSignal populated by `runTrigger` per dispatch so phases can observe mid-phase cancellation. Phases that wrap `runAgentWithTools` should pass it as `{ signal: ctx.signal }`.
- **`RunTriggerHandle.cancel(triggerEventId): boolean`** — abort one specific in-flight pipeline. Returns `true` if found, `false` if the id is unknown or the pipeline already completed. Delegates to `jobRunner.cancel(jobId)` in JobRunner mode, otherwise aborts the dispatch's own controller.
- **`runTrigger` callbacks `onCapacityFull(event)` and `onDispatchStart(event)`** — observability hooks for backpressure (fires when an event arrives at-cap) and dispatch lifecycle. Complements the existing `onStart` / `onComplete` / `onError`.

### Notes

- 290 tests in the core package (was 280). Five additional cycles covered the contract changes and the new APIs.
- `runPipeline`'s try-block around phase iteration was removed; the `finally` (cache clear) remains.
- All sibling packages release in lockstep at 2.4.0.

## [2.3.0] — 2026-05-20

Locked-version release alongside the new `@autonome-research/thread-phase-cli` package. Core changes are minor.

### Changed

- `runTrigger`'s `pipelineFactory` return type widened from `Phase<TCtx>[]` to `ReadonlyArray<Phase<TCtx>>` so factories can return frozen / typed-readonly arrays without casting. Source-compatible for existing call sites.

### Notes

- The CLI + auto-loader live in `@autonome-research/thread-phase-cli@2.3.0`. Core still has no CLI of its own; programmatic use is unchanged.

## [2.2.0] — 2026-05-20

Trigger interface — the entry-point abstraction for pipelines.

### Added

- **`Trigger<TInput>`** interface (`@autonome-research/thread-phase/triggers`) — the protocol every signal source implements. `start()` returns an async generator yielding `TriggerEvent<TInput>` with `{ id, occurredAt, input, metadata }`. `stop()` releases resources and ends the generator.
- **`TimerTrigger({ intervalMs, payload?, fireImmediately?, name? })`** — interval-based concrete impl. `payload` accepts a value, sync factory, or async factory called per fire. `fireImmediately` produces the first event without waiting for the first interval.
- **`runTrigger(trigger, pipelineFactory, options)`** — the canonical consumer. Reads events, builds `{ phases, ctx }` per event, dispatches pipelines. Optionally persists through `JobRunner` (with `jobStore` for status inspection). `maxConcurrency` is enforced as a blocking semaphore — backpressure flows back to the trigger, no events are dropped. Per-event failures are isolated; one bad pipeline doesn't stop the loop. Returns `{ done, stop }`.
- Subpath export: `@autonome-research/thread-phase/triggers`.

### Notes

- HTTP/queue/file-watch transports stay in `examples/triggers/` as recipes — wrap your own framework, no transports in core.
- 19 new tests (TimerTrigger + runTrigger), 280 total in the core package.

## [2.1.0] — 2026-05-20

Three new patterns. Additive only.

### Added

- **`whileCondition(name, { predicate, body, maxIterations })`** — general convergence loop. Async predicate runs before each iteration (`while`-semantics, not `do/while`). Emits `data` event `${name}.converged` on exit-by-predicate, `${name}.max-iterations` on cap-hit (and sets `ctx.stop`). Halts immediately if the body sets `ctx.stop`.
- **`match(name, { selector, cases, default? })`** — keyed dispatch over phases. Selector returns a case key, an unknown key (→ `default` or skip), or `null` (→ skip silently). Emits a `data` event with key `${name}.taken` and value `{ taken: key | 'default' | 'skip' }`. Generalizes if/else; for two-case dispatch, return the key from the selector.
- **`withRetry(phase, { maxAttempts, baseDelayMs, isFailure?, onRetry?, resetState? })`** — higher-order phase wrapper that retries on both thrown exceptions and `ctx.stop` (override with `isFailure`). Exponential backoff. Does not snapshot `ctx` — caller's responsibility to be idempotent or to use `resetState` to undo partial work between attempts. Preserves the inner phase's `name`.

### Notes

- Examples under `examples/patterns/`. Selection guidance in `docs/patterns.md`.
- 26 new tests, 261 total in the core package.

## [2.0.0] — 2026-05-20

Structural release. No new features.

### Changed

- Repo restructured as an npm-workspaces monorepo.
- Package renamed from `thread-phase` to `@autonome-research/thread-phase`.
- Pre-2.0 git history preserved via `git filter-repo`.

### Migrating from 1.x

```diff
- import { runPipeline } from 'thread-phase';
+ import { runPipeline } from '@autonome-research/thread-phase';
```

The sibling `thread-phase-agents` package was likewise renamed to `@autonome-research/thread-phase-agents` and folded into this monorepo.

## [1.5.0] — 2026-05-16

Single additive helper for wiring adapter events into the JobStore log.

### Added

- **`pipeAgentEventsToJobStore(bus, store, jobId, options?)`** — ships the canonical bridge that wires an `AgentEventBus` to a `JobStore`. Adapter events are wrapped as `PipelineEvent` of type `'data'` with key `agent:<source>:<type>` so consumers reading the log can filter by source. Options: `dropTypes` (skip high-volume types like `'text'`) and `key` (string or function override). Returns an unsubscribe callback. Store append failures are swallowed so a bad disk doesn't poison the event stream. 6 new tests, 235 total.

## [1.4.0] — 2026-05-16

Closes three holes from v1.3.0:

### Added

- **`withMemory(meta, { scope, inject, query? })`** decorator (`thread-phase/agents`) — wraps any `AgentAdapterMeta` so each invocation auto-recalls memory via `AgentRunOptions.memoryProvider`, splices the recalled string into the inner adapter config (caller-supplied `inject` callback because each adapter shapes its prompt field differently), captures the event stream, and calls `provider.remember(captured)` before `result` resolves. Memory backend failures surface as `native { kind: 'memory:recall_failed' | 'memory:remember_failed' }` events; the run never fails because of memory. No-op when `memoryProvider` is absent in options — decorate once, decide per-call whether memory applies.
- **`withThread(meta, thread, { applyResume? })`** decorator (`thread-phase/agents`) — wraps any adapter so events mirror into `thread.events`, resume tokens from `agent_start`/`agent_end` get written back to `thread.resumeTokens[meta.id]`, and (when `applyResume` is provided) the thread's existing per-adapter resume token gets spliced into the next run's config. Works without `applyResume` for adapters with `resumption: 'none'` — still mirrors events.
- **`isSteerable(run)`** type guard for safe narrowing of `AgentRun` → `SteerableAgentRun` at the call site. Adapters whose underlying runtime supports `followUp()` (ACP-based: hermes, openclaw) now return the steerable subtype at runtime; consumers narrow via `if (isSteerable(run)) await run.followUp(...)`.
- **`TurnAccumulator.endTurn(usage?)`** for adapters whose underlying runtime has natural turn ordering (tool calls THEN turn boundary, like ACP's `session/prompt` response). Emits a `turn_end` event NOW with the current turn's text + tool-call count, then resets. Complements `markTurnEnd()` (which defers for the OpenAI runner's boundary-before-tool-calls quirk).

### Notes

- All additive. Existing exports, behavior, and tests unchanged. 229 tests pass (was 211; +18 for the two new decorators).
- Companion change in `thread-phase-agents`: the ACP chassis adopts `followUp()` via the new `endTurn()` helper. See that package's CHANGELOG.

## [1.3.0] — 2026-05-16

The headline change: thread-phase now composes deterministic phases over **heterogeneous agents**. `runAgentWithTools` remains the canonical primitive for raw OpenAI-compatible inference; the new `AgentAdapter` protocol is the surface for delegating to ready agents (Claude Code, Hermes, Codex, OpenClaw, Anthropic SDK). Sibling adapter implementations live in the new [`thread-phase-agents`](https://github.com/Code4me2/thread-phase-agents) package; the protocol itself ships here.

This is a fully additive release. Every existing export is unchanged; new exports land under the `thread-phase/agents` and `thread-phase/agents/test-utils` subpaths. The protocol surface is marked `@internal` while it stabilizes — pin the minor version if you depend on it.

### Added

- **`AgentAdapter` protocol** (`thread-phase/agents`) — `AgentRun` (events / result / abort), `AgentRunResult`, `AgentEvent` (discriminated union of `agent_start | text | thinking | tool_call | tool_result | turn_end | agent_end | error | native`), `AgentCapabilities`, `AgentAdapterMeta`, `defineAgentAdapter`, `ResumeToken`, `SerializableError`, `SteerableAgentRun`. Every event carries a `source` field naming the emitting adapter.
- **`Thread` primitive** for cross-phase conversation state. Holds canonical events plus per-adapter resume tokens; `threadToMessages` renders to OpenAI-style messages for cross-adapter handoff when no native resume path exists.
- **`MemoryProvider` interface** — `recall(scope, query?)` / `remember(scope, events)`. thread-phase ships no implementations; bind Honcho, Letta, Mem0, or a custom backend yourself. See `examples/honcho-memory.ts`.
- **`inferenceAgent`** — the in-tree reference adapter, wraps `runAgentWithTools` 1:1. Declares `streaming: 'text'`, `cancellation: 'cooperative'`, `resumption: 'none'`, `structuredOutput: 'prompted'`.
- **Run helpers** for adapter authors — `composeAbort` (combines `options.signal` with an internal controller via `AbortSignal.any`), `createEventQueue` (single-consumer queue with optional bus mirroring, throws on second iterator), `lazyEvents` (wraps an iterable so that iterating it kicks off the underlying run), `TurnAccumulator` (handles turn-marker-before-tool-calls deferral so adapters don't reimplement it).
- **Structured output helpers** — `applyStructuredOutputPrompt`, `extractResponseBlock`, `parseStructuredFromText`, `parseStructured`, `StructuredOutputParseError`. Adapters declaring `structuredOutput: 'prompted'` apply the instruction up front and parse the `<response>` block on completion; parse failures land in `AgentRunResult.parseError` for caller diagnosis.
- **`AgentEventBus`** + `createEventBus` — multi-subscriber pub/sub for orchestrator-side observation. Adapters that receive one via `AgentRunOptions.eventBus` mirror their event stream automatically.
- **`AgentCapabilityError` + `requireCapability`** — patterns assert adapter capabilities at construction time so pipelines fail fast.
- **`boundedFanoutOf` pattern** (`thread-phase/patterns`) — adapter-driven variant of `boundedFanout` with automatic event-bus and signal propagation. Returns `AgentRunResult[]` in input order; `mode: 'fail-fast' | 'collect'` mirrors `boundedFanout`'s shape. Includes `BoundedFanoutOfError` for fail-fast rejections.
- **Adapter conformance suite** (`thread-phase/agents/test-utils`) — `runAdapterConformance({ meta, buildConfig })` asserts the 14 lifecycle invariants every adapter must satisfy. Imported by both in-tree tests and sibling-package adapters.
- **`createMockAgent`** for tests that need a scripted `AgentAdapter` (`thread-phase/agents/test-utils`).
- New events on `AgentEvent`: `thinking` (intra-turn reasoning content for adapters that surface it separately from final text), with `error.transient` semantics documented (`true` for retryable errors — rate limits, transient 5xx — `false` for terminal ones).
- **`examples/honcho-memory.ts`** — runnable example wiring Honcho as a `MemoryProvider`. Adds `@honcho-ai/sdk` as a devDep.

### Changed

- `package.json` adds new subpath exports: `./agents`, `./agents/test-utils`. Existing subpaths (`./patterns`, `./context`, `./session`, `./tools`, `.`) unchanged.
- `vitest` moved to `peerDependenciesMeta` (optional) — only consumers of `thread-phase/agents/test-utils` need it.

### Notes

- The `AgentAdapter` surface is `@internal` in all JSDoc. The protocol stabilizes when the first sibling-package release tags 1.0; until then, every export here may move in a minor release.
- 211 tests pass in this repo. The sibling [`thread-phase-agents`](https://github.com/Code4me2/thread-phase-agents) ships its own 89-test conformance + integration suite against `acpAgent`, `hermesAgent`, `openClawAgent`, `anthropicAgent`, `codexAgent`, `claudeCodeAgent`.

## [1.2.1] — 2026-05-01

Tightens the `mode: 'collect'` + `signal` interaction. v1.2.0 still threw `AbortError` post-loop when the signal aborted, even in collect mode — which discarded the partial results that the consumer had paid for and that collect mode was supposed to preserve. This is the soft-cancel semantics that the cron-driven use case actually wants: stop dispatching new work, return what's done.

### Changed
- `boundedFanout` with `mode: 'collect'` no longer rejects on `signal` abort. Instead it returns a full-length, position-stable `FanOutResult<T>[]`: items that completed before the abort keep their `{ ok: true, value }` or real `{ ok: false, error }`; items that were never started (or whose runner exited via the in-loop signal check before recording a result) get a synthetic `{ ok: false, error: AbortError }` slot. `mode: 'reject'` (default) is unchanged — still throws on abort.
- `streamingBoundedFanout` with `mode: 'collect'` mirrors the change: the generator no longer throws on abort. The terminal `done_collected` event carries the same partial-with-synthetic-fills `FanOutResult<T>[]`.
- Header doc updated to spell out the cancellation × mode interaction.

### Notes
- `onItemError` does NOT fire for synthetic AbortError fills — the runner never ran for those items, so there's no per-item error to report. It still fires normally for real runner throws (including AbortError thrown by an in-flight runner that observed the forwarded signal and unwound).
- Discriminate "in-flight aborted" from "never started" via the runner side effects, not the result shape: a real in-flight abort has whatever side effects the runner did before the throw (DB writes, etc.); a synthetic fill has none.
- 6 new tests cover: pre-aborted call returning all-AbortError slots, mid-flight abort returning partial results with no rejection, real per-item errors preserved alongside synthetic fills, reject-mode unchanged, both streaming variants.
- 127 tests pass (was 121).

## [1.2.0] — 2026-05-01

Closes the cron/automation feedback loop on `boundedFanout`. Three layered footguns in the v1.0/1.1 surface:

1. **Silent waste of expensive work.** When a runner threw, `Promise.all` rejected immediately, but the other workers kept pulling items off the cursor. Their results landed in a `results[]` array that the function had already abandoned — typically multi-second LLM calls whose tokens were paid for and discarded with no telemetry.
2. **No mid-flight cancellation.** `signal` aborted *new* dispatches but couldn't reach a runner already in an in-flight call.
3. **Lost error context.** Only the first thrown error became the rejection value; the rest were swallowed.

Every consumer (chiya included) was rolling its own try/catch + per-runner deadline check + ArticleResult-shaped sum type to work around #1 and #2. This release pulls those workarounds into the framework.

### Added
- `BoundedFanOutOptions.mode: 'reject' | 'collect'`. Default `'reject'` preserves v1.1 behavior. `'collect'` never rejects on runner errors; each result slot is `FanOutResult<T> = { ok: true, value: T } | { ok: false, error: Error }`. Workers continue draining after individual failures.
- `BoundedFanOutOptions.onItemError(event)`. Fires once per failed runner regardless of mode — in `'reject'` mode it fires *before* the rejection propagates, so consumers can capture context for telemetry. Pairs naturally with `onItemDone`.
- `FanOutResult<T>` type union, exported from `thread-phase/patterns`.
- `ItemErrorEvent<TItem>` type, exported from `thread-phase/patterns`.
- `streamingBoundedFanout` yields a new `item_error` event in `'collect'` mode (with the same `progress` field as `item_done`). The terminal event is `done` in reject mode and `done_collected` in collect mode.

### Changed
- **`runner` signature** now receives the abort signal as its third argument: `(item, index, signal?: AbortSignal) => Promise<TResult>`. Forward this into any abortable downstream call (HTTP, `runAgentWithTools({signal})`) so cancellation can reach a runner already in-flight, not just gate the next dispatch. Existing callers that ignore the third arg are fully backward-compatible.
- Function overloads on `boundedFanout` and `streamingBoundedFanout` so the return type discriminates on `mode` (`mode: 'collect'` → `FanOutResult<T>[]`; default → `T[]`).
- Non-`Error` throws from a runner are coerced to `Error` (with the original value as the message) before being recorded or propagated. Previously a `throw 'string'` would surface as a non-Error rejection.

### Notes
- This is a fully additive release. No existing tests needed changes; 10 new tests cover collect-mode result shape, drain-after-failure semantics, onItemError ordering in both modes, signal forwarding into runner, and `done_collected` in the streaming variant.
- The cron/automation use case (e.g. chiya-library's librarian) can now: (a) drop its inner try/catch wrapper and rely on `mode: 'collect'` for the result-or-error sum; (b) replace its bespoke `ctx.deadlineAt` checked-by-each-runner pattern with a `setTimeout(() => controller.abort(), N*60*1000)` at the entry point, forwarding the signal into `runAgentWithTools`. `parallelFanout` is unchanged in this release; if there's demand it can grow the same options later.

## [1.1.0] — 2026-04-30

Driven by production experience with `Code4me2/chiya-library`: a 10-minute systemd timer with a 25-minute soft deadline could overlap with itself, leaving two pipelines racing on the same shared work-queue rows. Adding a framework primitive — instead of pushing every consumer to roll their own flock/pidfile/SQL guard — keeps the cron-driven use case (one of the README's two headline use cases) coherent.

### Added
- `JobStore.acquireExclusive(name, input)` — atomically claim a single-runner slot. If no job with `name` is currently RUNNING, inserts a new job row directly in RUNNING state and returns its id; otherwise returns `null`. The check + insert run inside one transaction. Use this from the entry point of cron-driven pipelines to make overlapping runs impossible.

### Changed
- `SqliteJobStore.setRunning` is now idempotent on `started_at` (`COALESCE(started_at, datetime('now'))`). Previously a second `setRunning` call would clobber the original start time. This matters because `JobRunner.run` always calls `setRunning` after `acquireExclusive` already set the timestamp at claim time.

### Notes
- This is technically a breaking change for *implementors* of `JobStore` (a new required method). The bundled `SqliteJobStore` is the only known implementation; downstream consumers using it directly are unaffected. Custom backends need to add a transactional `acquireExclusive`.

## [0.1.0] — 2026-04-29

The first major cycle after v0.0.1, driven by production experience with `Code4me2/chiya-library`. Every Tier 1 ROADMAP item from v0.0.1 was experience-confirmed and is now resolved.

### Added
- `AgentRunResult.finishReason` — `'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | 'error' | 'unknown'`. Branch on `'length'` to detect truncated output.
- `AgentRunResult.usage` — `{ promptTokens, completionTokens, totalTokens }`, summed across every round.
- `AgentRunResult.executedToolCalls` — every tool call the agent actually executed during the run, in order. Use this to verify what the agent did vs. what it claimed in text.
- `AgentRunnerOptions.signal` — `AbortSignal` plumbed through into `client.chat.completions.create({ signal })`. Cancellation aborts the in-flight stream and the loop between rounds.
- `AgentRunnerOptions.onStreamEvent` — receive `content_delta`, `tool_call_started`, `tool_call_complete`, and `round_complete` events as they arrive.
- `AgentRunnerOptions.verifyResult` — defensive validation hook that runs once per agent invocation, just before the result is returned. Catches silent confabulation by validating claimed output against `executedToolCalls`.
- `JobRunner.cancel(jobId, reason)` — request cancellation of an in-flight job. Aborts the controller (which propagates into any inference call wired to `signalFor(jobId)`) and marks the job FAILED.
- `JobRunner.signalFor(jobId)` — `AbortSignal` for a running job. Phase code passes this into `runAgentWithTools({ signal })` so cancellation reaches the inference call.
- `streamingBoundedFanout` — same scheduling as `boundedFanout`, but yields per-item events as items complete plus a final `done` event with the full ordered result array.
- `parallelPhases` — composite phase that runs sub-phases concurrently and merges their event streams.
- `streamToSSE(options)` — adapt a JobRunner live stream + replay log into SSE wire format. Handles replay-on-reconnect via `Last-Event-ID`.
- `PipelineCache.namespace(name)` — typed sub-cache prefixed by `${name}:`. Sub-caches share the underlying store; `clear()` on a sub-cache only drops keys in that namespace.
- `TokenBudgetConfig.protectFirst` / `protectLast` / `protectLastAggressive` — magic numbers in agent-runner moved onto config so they're tunable per pipeline.
- `Phase<TCtx, TEvent>` — second optional type parameter for typed custom events. Default remains `PipelineEvent`.
- Sqlite schema migrations via `PRAGMA user_version` — future schema changes can roll forward without dropping data.
- Inference-provider parser-mismatch warning — when content looks like a tool call but `tool_calls` is empty AND tools were available, the runner logs a warning hinting at vLLM's `--tool-call-parser`.

### Changed
- Agent-runner now uses `stream: true` internally with `stream_options: { include_usage: true }`. The non-streaming `runAgentWithTools` signature is unchanged; streaming is observable via `onStreamEvent`.
- `src/agent-runner.ts` split into focused modules under `src/agent/` (types, openai-adapter, stream-consumer, retry, runner, parse-json). The original path remains as a back-compat shim re-exporting the public surface.
- `SqliteJobStore.listJobs` — single parameterized query instead of two near-duplicates.
- `sanitizeToolPairs` — partial-orphan edge case fixed. When an assistant emits multiple tool calls and only some have matching results, stub results for the orphans are now appended *after* the real ones rather than skipped entirely.

### Documented
- `JobStore` interface docstring committed to sync interface for v1, with rationale and migration path for an additive `JobStoreAsync` interface if/when async backends are needed.

## [0.0.1] — 2026-04-26

Initial scaffold. Phase framework, agent runner, token-budget machinery, tool registry, sqlite-backed job store, and pattern templates.

### Added
- `Phase<TCtx>`, `runPipeline(phases, ctx)`, `BasePipelineContext`, `requireCtx`
- `runAgentWithTools(config, messages, options)` with token-budget machinery (estimator, capper, deterministic + aggressive compressor)
- `ToolRegistry` with optional ajv arg validation
- `JobStore` interface + `SqliteJobStore` impl
- `JobRunner` for live-streamed pipeline execution with persistent event log
- `PipelineCache` per-pipeline in-memory cache
- `parallelFanout`, `boundedFanout`, `intentGate`, `preflightConfidence`, `synthesizeWithFollowup`, `spotCheck` patterns
- `AgentConfig.extraBody` for provider-specific request fields (vLLM `chat_template_kwargs`, etc.)
- 49 tests across 7 files
- Smoke test suite caught two real bugs (empty content from `tools: null` serialization; empty content from no-tools nudge)

[Unreleased]: https://github.com/Code4me2/thread-phase/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Code4me2/thread-phase/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Code4me2/thread-phase/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Code4me2/thread-phase/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Code4me2/thread-phase/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Code4me2/thread-phase/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Code4me2/thread-phase/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Code4me2/thread-phase/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Code4me2/thread-phase/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/Code4me2/thread-phase/releases/tag/v0.0.1
