# Roadmap

Known limitations and deferred work. Items marked **(experience-confirmed)** were validated against real production use of thread-phase by `Code4me2/chiya-library` (digest + librarian pipelines, ~hundreds of articles per day). Items without that mark were guesses from the v0.0.1 internal review.

Addressed in the v0.0.1 cycle:
- ✅ Tool registry with ajv arg validation (commit `651570c`)
- ✅ JobStore as an interface, SqliteJobStore as impl (commit `039b6af`)
- ✅ Test suite — 49 tests across 7 files (commit `b38817c`)
- ✅ Two real bugs caught by smoke testing against vLLM (commit `2497857`)
- ✅ `boundedFanout` pattern (concurrency-capped fan-out) (commit `c0e0fe6`)
- ✅ `AgentConfig.extraBody` for provider-specific extensions (commit `9417e4f`)

Addressed in the v0.1 cycle (this cycle — see commits below):
- ✅ `AgentRunResult` shape upgrade — `finishReason`, `usage`, `executedToolCalls`
- ✅ Cancellation: `AbortSignal` plumbed through `AgentRunnerOptions` and into `client.chat.completions.create({ signal })`; `JobRunner.cancel(jobId)` + `JobRunner.signalFor(jobId)`
- ✅ Streaming: agent-runner uses `stream: true` with `stream_options.include_usage`; per-delta `onStreamEvent` callback
- ✅ `streamingBoundedFanout` — yields per-item events as items complete
- ✅ `verifyResult` hook on `AgentRunnerOptions` for catching silent confabulation
- ✅ Inference-provider parser-mismatch warning (vLLM `--tool-call-parser`)
- ✅ `PipelineCache.namespace(name)` — typed sub-cache prefixed by `${name}:`
- ✅ sqlite schema migrations via `PRAGMA user_version` migration runner
- ✅ `protectFirst` / `protectLast` / `protectLastAggressive` moved onto `TokenBudgetConfig`
- ✅ `Phase<TCtx, TEvent>` parameterized for typed custom events
- ✅ `SqliteJobStore.listJobs` SQL dedup (single parameterized query)
- ✅ `streamToSSE` helper for HTTP consumers (replay + live + heartbeat)
- ✅ `sanitizeToolPairs` partial-orphan edge case (stubs now appended after real results)
- ✅ Test suite — 92 tests across 11 files

---

## Tier 2 — known weaknesses, not yet hit hard

### Compressor improvements
- **Status:** Being worked on in a separate project; will be ported over.
- **What real use showed:** Hasn't bitten yet. Both pipelines fit comfortably in context. But the existing `DeterministicCompressor` replaces tool-result content with an opaque marker; first long-context run will hurt.

### Token-estimator accuracy
- **Severity:** Low until close to the context limit.
- **Validation:** Not yet — chiya pipelines stay well under the budget.
- **What it needs:** A model-aware tokenizer; current `chars/4` is fine for back-of-envelope.

### `PipelineEvent` union extensibility — partially addressed
- **Status:** `Phase<TCtx, TEvent>` now takes a TEvent type parameter; orchestrator and JobRunner are parameterized. Downstream apps can declare `type MyEvent = PipelineEvent | { type: 'mine'; ... }` and get narrowing.
- **Still open:** No first-class helper for emitting custom events without losing the framework's terminal-event shape; downstream is responsible for ensuring TEvent is a superset of `done`/`error`.

---

## Tier 3 — quality-of-life helpers (deferred)

### Multi-modal inputs
- **What's needed:** Image/audio in `UserMessage.content`. OpenAI-compat but requires the discriminated-content-block model.
- **Validation:** Not yet — chiya is text-only. Larger surface change, deferred until a downstream consumer actually needs it.

---

## Known correctness gaps

### `parseJSON` silent fallback — addressable now via `finishReason`
- **What happens:** When agent output is truncated mid-JSON (because `finish_reason='length'`), `parseJSON` emits a `console.warn` and returns the fallback. Caller gets the fallback with no signal that parsing failed.
- **What it needs:** Caller is now expected to inspect `result.finishReason` and branch on `'length'` before trusting `parseJSON` output. If the field reads `length`, the JSON was almost certainly truncated. The runner already exposes the signal — callers should adopt the pattern.

---

## Design observations (not bugs)

### Patterns are thin — confirmed
- v0.0.1 review observation held up in production. `boundedFanout` was the only `patterns/*` helper used heavily by chiya-pipelines and earned its keep. The other four (`parallelFanout`, `intentGate`, `preflightConfidence`, `synthesizeWithFollowup`, `spotCheck`) were not used. Not a problem — they exist to *name* shapes, not enforce them.
- v0.1 added `streamingBoundedFanout` — same shape as `boundedFanout` but yields per-item events for in-phase progress visibility. This was the canonical "buffer-then-emit" workaround in chiya, now a first-class helper.
- chiya-pipelines added one new pattern internally (defensive path validation in `processBatch`). The `verifyResult` hook on `AgentRunnerOptions` is the framework-level expression of this — caller-supplied predicate that runs before the result is returned.

### Same-DB co-tenancy works
- chiya-pipelines runs `ArticleStore` (domain-specific) and `SqliteJobStore` (framework) on the same sqlite file with separate connections. WAL mode handles concurrency cleanly. No locking issues across hundreds of librarian + digest cycles. This pattern is worth documenting as the recommended shape: "let downstream apps store their domain data in the same DB file as the framework's job/event log."

---

## Suggested order for the next development cycle

The Tier 1 items from the previous cycle are now resolved. Future work should focus on:

1. **Compressor improvements** — the existing opaque-marker compressor is a known weakness for long-context summarization workloads. Port the work from the separate project once stable.
2. **Tokenizer accuracy** — when the first downstream user pushes near context limits, swap in a model-aware tokenizer.
3. **Multi-modal** — only when a real consumer needs it.

Everything else can wait for a real downstream user to hit it.
