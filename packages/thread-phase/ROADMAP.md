# Roadmap

Known limitations and deferred work, captured from the review at v0.0.1.
Each item lists severity, scope, and when it would block real use.

Addressed in the v0.0.1 cycle:
- ✅ Tool registry with ajv arg validation (commit `651570c`)
- ✅ JobStore as an interface, SqliteJobStore as impl (commit `039b6af`)
- ✅ Test suite — 49 tests across 7 files (commit `b38817c`)
- ✅ Two real bugs caught by smoke testing against vLLM (commit `2497857`)

## Deferred — externally tracked

### Compressor improvements
- **Status:** Being worked on in a separate project; will be ported over.
- **What's there now:** `DeterministicCompressor` replaces tool-result content with `[Previous tool result: N chars — compressed to save context]`. All semantic info is lost.
- **Why it matters:** At high context utilization the agent loses access to anything older than the protected tail.
- **When it blocks:** Long-running pipelines that revisit prior tool results, or any pipeline that breaches the compression threshold non-trivially.
- **Action:** Port the upstream compressor when ready; expected to slot into `src/context/compressor.ts` behind the existing `CompressorStrategy` interface.

## Deferred — production readiness

### Cancellation + per-call timeouts
- **Severity:** High for any pipeline that runs more than a few seconds.
- **What's there now:** No `JobRunner.cancel(jobId)`. No `AbortController` plumbed through `runAgentWithTools`. If vLLM hangs, the framework hangs.
- **What it needs:** Plumb an `AbortSignal` through `AgentRunnerOptions`, attach to the `openai` client request, and surface a `JobRunner.cancel()` that aborts the in-flight phase generator.
- **When it blocks:** First production pipeline that needs a max-run-time guarantee, or any web-facing consumer that needs to abort on disconnect.

### Cost / usage tracking
- **Severity:** Medium — easy fix, high information value.
- **What's there now:** OpenAI responses include `usage: { prompt_tokens, completion_tokens, total_tokens }` and we discard them.
- **What it needs:** Aggregate per-agent-call totals into the `AgentRunResult.activity` (or a new `usage` field), bubble up through phases, and persist on the `JobRecord` (`promptTokens`, `completionTokens`).
- **When it blocks:** Anyone trying to cost-attribute a long pipeline run.

### Streaming agent output
- **Severity:** High for UX, low for correctness.
- **What's there now:** `agent-runner` uses non-streaming chat completions. Content arrives as a single block at the end of each round.
- **What it needs:** Switch to `stream: true`, accumulate chunks into the internal `AssistantMessage` shape, yield `content` events as they arrive, handle incrementally-streamed tool calls (OpenAI emits `tool_calls` deltas per chunk).
- **When it blocks:** Anything user-facing where TTFT matters, or any phase where you'd want to act on partial content (e.g. early tool dispatch).

### Token-estimator accuracy
- **Severity:** Low until you push close to the context limit.
- **What's there now:** `RoughTokenEstimator` is `chars / 4`. Fine for back-of-envelope.
- **What it needs:** A Qwen-aware tokenizer (or whichever model is in use). The interface is pluggable — swap a `TokenEstimator` impl.
- **When it blocks:** Pipelines that consume >50% of context, where 20% estimator drift causes premature compression or budget overruns.

## Deferred — architectural cleanup

### `PipelineCache` is untyped `Map<string, unknown>`
- **Severity:** Low.
- **What's there now:** Two phases that accidentally use the same cache key collide silently.
- **What it needs:** A `cache.namespace('foo')` helper returning a typed sub-cache, or per-phase typed cache classes.
- **When it blocks:** First time two phases collide on a key. (Hasn't happened yet.)

### `PipelineEvent` union is fixed
- **Severity:** Low.
- **What's there now:** Custom domain events use the generic `{ type: 'data', key, value: unknown }` shape and lose union narrowing.
- **What it needs:** Parameterize `Phase<TCtx, TEvent>` so downstream apps can extend the event union with strongly-typed custom events.
- **When it blocks:** When a downstream pipeline emits a lot of structured custom events and switch-narrowing on `event.type` becomes valuable.

### `protectFirst` / `protectLast` magic numbers in agent-runner
- **Severity:** Low.
- **What's there now:** Hardcoded `protectFirst: 1, protectLast: 4` (and `: 6` in the COMPRESS path) inside the agent runner.
- **What it needs:** Move onto `TokenBudgetConfig` so they're tunable per pipeline.

### sqlite schema migrations
- **Severity:** Low until the next schema change.
- **What's there now:** `CREATE TABLE IF NOT EXISTS`. Existing DBs won't pick up new columns.
- **What it needs:** A tiny migration runner using `PRAGMA user_version`.
- **When it blocks:** First non-additive schema change after any user has data on disk.

### `SqliteJobStore.listJobs` has two near-identical SQL paths
- **Severity:** Trivial.
- **What's there now:** A `name`-filter branch and an unfiltered branch with shared `baseSelect`.
- **What it needs:** Either dynamic SQL composition or a tiny query builder. Cosmetic.

## Deferred — quality-of-life helpers

### SSE helper
- **What's needed:** A `streamToSSE(runner, jobId, res)` helper for HTTP consumers. Five-line write when first needed; not in v0 because no consumer exists yet.

### Multi-modal inputs
- **What's needed:** Image/audio support in `Message`. OpenAI supports image content blocks; would require extending `UserMessage.content` to a discriminated union.
- **When it blocks:** First downstream pipeline that needs to send images.

## Known correctness gaps

### `sanitizeToolPairs` skips stub insertion when a tool message follows
- **Captured in** `__tests__/sanitizeToolPairs.test.ts` ("handles assistant with multiple calls where one is orphaned").
- **What happens:** When an assistant emits multiple tool calls and only some have matching tool-result messages, the stub-insertion path checks if the *next* message is `role: 'tool'`. If it is (because a partial set of results follows), no stub is inserted for the orphan. The orphan persists and the next API call will reject.
- **Severity:** Medium — only triggers in compressor scenarios that drop tool results from the middle of a multi-call assistant turn.
- **Fix sketch:** When the next message is a `tool` message, check whether *its* `toolCallId` matches one of the orphaned ids. If not, the orphans need stubs inserted before the existing tool messages.

## Design observations (not bugs)

### Patterns are thin
The five `patterns/*` helpers are templates more than abstractions. `parallelFanout` is essentially `Promise.all`. They have value as named templates but don't carry significant code. A user might reasonably skip them and write Phases from scratch — that's fine; they exist to *name* common shapes, not enforce them.
