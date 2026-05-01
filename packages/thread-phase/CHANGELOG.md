# Changelog

All notable changes to thread-phase will be documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project follows [Semantic Versioning](https://semver.org/) starting at v1.0.0. Pre-v1, breaking changes may land in any release — read these notes before upgrading.

## [Unreleased]

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

[Unreleased]: https://github.com/Code4me2/thread-phase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Code4me2/thread-phase/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/Code4me2/thread-phase/releases/tag/v0.0.1
