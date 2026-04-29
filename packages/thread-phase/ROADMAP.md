# Roadmap

thread-phase is a small, focused TypeScript framework for the iterated tool-use loop against any OpenAI-compatible inference endpoint (vLLM, OpenAI, Ollama, llama.cpp), composed into multi-phase pipelines with a typed shared context. The goal is **not** to be the most flexible agent framework — it's to be the right answer for one specific niche: TypeScript projects running open-weights or OpenAI inference, with iterated tool use, persistent event logs, and concurrency-capped fanout for batch workloads.

If you outgrow this niche — e.g. you need a real DAG scheduler, distributed execution, or cross-language workflows — the right move is to use Temporal/LangGraph/Inngest for orchestration and import thread-phase for the agent loops inside each node. The framework is designed to compose under those tools rather than replace them.

---

## Status: pre-v1, validated in production

thread-phase is currently used by `Code4me2/chiya-library` (digest + librarian pipelines, ~hundreds of articles per day). All items marked **(experience-confirmed)** were validated against that production use rather than guessed from internal review.

---

## Already shipped

### v0.0.1 cycle
- ✅ Tool registry with ajv arg validation (commit `651570c`)
- ✅ JobStore as an interface, SqliteJobStore as the bundled impl (commit `039b6af`)
- ✅ Test suite — 49 tests across 7 files (commit `b38817c`)
- ✅ Two real bugs caught by smoke testing against vLLM (commit `2497857`)
- ✅ `boundedFanout` pattern (concurrency-capped fan-out) (commit `c0e0fe6`)
- ✅ `AgentConfig.extraBody` for provider-specific extensions (commit `9417e4f`)

### v0.1 cycle (Tier 1 + Tier 2 + Tier 3, all experience-driven)
- ✅ `AgentRunResult` shape upgrade — `finishReason`, `usage`, `executedToolCalls`
- ✅ Cancellation: `AbortSignal` plumbed through `AgentRunnerOptions` and into the inference call; `JobRunner.cancel(jobId)` + `signalFor(jobId)`
- ✅ Streaming: agent-runner uses `stream: true`; per-delta `onStreamEvent` callback
- ✅ `streamingBoundedFanout` — yields per-item events as items complete
- ✅ `verifyResult` hook on `AgentRunnerOptions` for catching silent confabulation
- ✅ Inference-provider parser-mismatch warning (vLLM `--tool-call-parser`)
- ✅ `PipelineCache.namespace(name)` — typed sub-cache prefixed by `${name}:`
- ✅ sqlite schema migrations via `PRAGMA user_version` migration runner
- ✅ `protectFirst` / `protectLast` / `protectLastAggressive` on `TokenBudgetConfig`
- ✅ `Phase<TCtx, TEvent>` parameterized for typed custom events
- ✅ `SqliteJobStore.listJobs` SQL deduped (single parameterized query)
- ✅ `streamToSSE` helper for HTTP consumers (replay + live + heartbeat)
- ✅ `sanitizeToolPairs` partial-orphan edge case fixed
- ✅ `agent-runner.ts` split into focused modules (types/openai-adapter/stream-consumer/retry/runner/parse-json)
- ✅ `parallelPhases` pattern — concurrent sub-phases as a composite phase
- ✅ Test suite — 98 tests across 12 files

---

## Path to v1

The codebase itself is ready. The work is in surfaces around it — making thread-phase legible to someone who isn't already in the user's head. Items in suggested order:

### V1.1 — API surface audit + stability commitment
Audit every export from the package's entry points. Decide which are **stable** (covered by semver) and which are **internal** (exported but no stability guarantee). My split:

- **Stable**: `runAgentWithTools`, `parseJSON`, `Phase`, `runPipeline`, `BasePipelineContext`, `PipelineEvent`, `requireCtx`, `PipelineCache`, all `patterns/*`, `JobRunner`, `JobStore` interface, `SqliteJobStore`, `streamToSSE`, `ToolRegistry`, the `AgentConfig` / `AgentRunResult` / `AgentRunnerOptions` types, `Message` and tool types from `messages.ts`.
- **Internal** (exported for advanced callers, but not API-stable): `consumeStream`, `normalizeFinishReason`, `looksLikeToolCallText`, `isRetryableError`, `isAbortError`, `toOpenAIMessages`, `toOpenAITools`, internal compressor / capper / token-estimator constructors.

Mark internal items with `@internal` JSDoc tags and a one-line note in the main barrel file.

### V1.2 — README rewrite for public consumption
Currently the README is internal-style (~80 lines, terse). v1 needs:
- 30-second pitch
- Install + 50-line quickstart
- "Is this for me?" decision box (when to use, when to reach for something else)
- Mental model (Phase, ctx, runPipeline, runAgentWithTools)
- Links to examples + ROADMAP + CHANGELOG

Also: reframe inference-provider story. The current README hedges with "agnostic"; v1 should own the niche as **OpenAI-compatible (vLLM / Ollama / OpenAI / llama.cpp)**. Anthropic users have the SDK and content-block model directly — covering them adds ~200 lines for a user base that doesn't need this layer.

### V1.3 — Examples directory
Replace the single `examples/smoke.ts` with five focused, runnable examples:
- `bare-agent.ts` — one tool, one call, no patterns. The "hello world."
- `multi-phase-pipeline.ts` — linear pipeline with one `parallelPhases` branch.
- `streaming-consumer.ts` — printing content deltas + tool-call lifecycle as they arrive.
- `bounded-fanout.ts` — per-item agent over a list, concurrency-capped.
- `sse-server.ts` — `JobRunner` + `streamToSSE` wired into a small HTTP handler.

Each ~30-80 LOC, runnable via `tsx`, points at a configurable inference endpoint.

### V1.4 — `docs/patterns.md` selection guide
A 1-page table mapping "I want to do X" → "use pattern Y." Covers all 8 patterns. Each entry: the shape it captures, when to reach for it, when *not* to use it, link to source. Without this, users will reach for the wrong primitive.

### V1.5 — CHANGELOG.md + CONTRIBUTING.md
- `CHANGELOG.md`: capture v0.0.1 → v0.1 → v1 in keep-a-changelog format, commit to maintaining it per release.
- `CONTRIBUTING.md`: brief. Issues welcome. PRs: typecheck + tests must pass, follow existing pattern style, no CLA, scope discussion before large PRs. Explicit "what's in scope and what's out of scope" pointer to this ROADMAP.

### V1.6 — CI workflow
`.github/workflows/test.yml`: typecheck + vitest on Node 20 + 22 (drop 18, EOL'd 2025-04). Trigger on push + PR. Cache npm. Required checks before merging to master once public.

### V1.7 — Test coverage gaps
- End-to-end `JobRunner.cancel` propagating through a (mocked) agent loop — currently cancel and agent are tested separately, not stitched.
- `parallelPhases` interleaving with one branch erroring while another is mid-flight.
- SSE heartbeat behavior under client disconnect mid-job.
- `verifyResult` hook running async and seeing the populated `executedToolCalls`.

~150-200 LOC of new tests.

### V1.8 — Stability docs (JobStore sync, semver policy)
- ROADMAP + `JobStore` docstring commit to sync interface for v1, with rationale (sqlite hot path, fire-and-forget event writes) and migration path (additive `JobStoreAsync` if/when needed).
- README section on semver: patch = fix, minor = additive, major = breaking; `@internal` exports excluded.

### V1.9 — Tag v1.0.0, flip repo public, optionally publish to npm
Final step. Bump `package.json` to 1.0.0, tag the release, make the GitHub repo public, decide on npm publication.

---

## Deferred — tracked, will land when ready

### Compressor improvements + long-context support
Current `DeterministicCompressor` replaces tool-result content with an opaque marker. It's a known footgun for long-document summarization. Hasn't bitten chiya in production (both pipelines fit comfortably in context), but anyone running a hierarchical summarization workload will hit it.

**Status:** being worked on in a separate project; the user will port it in. Until then, v1 is explicit in the README that thread-phase is **for short-to-medium context multi-phase pipelines**; long-document summarization isn't a v1 use case. After porting, it'll be a minor bump.

### Token-estimator accuracy
Current `RoughTokenEstimator` uses chars/4. Fine for budget enforcement, off by 10-20% for actual counts. Replacing with a tiktoken-backed estimator is straightforward (the interface is already pluggable). Defer until somebody pushes near context limits.

### `parseJSON` silent fallback
Already addressable by callers via `result.finishReason === 'length'` — when the agent run was truncated, JSON parsing almost always fails. The signal is there; callers should adopt the pattern. We could ship a `parseJSONStrict` that throws on failure, but that's a 5-line addition the day someone asks for it.

---

## Out of scope — deliberate non-goals

These are *not* coming. The reasoning matters: each of these would either dilute the framework's identity or pull thread-phase into a domain where better tools already exist.

### Node/edge graph framework
A 400-600 LOC scheduler that schedules a declared DAG of nodes. Real benefit (diamond shapes, automatic parallelism, partial re-execution, visualization), but:
- chiya's pipelines are linear with one fanout; the workloads thread-phase serves aren't graph-shaped.
- The 95% of DAG shapes that *do* arise are covered by `parallelPhases` + `intentGate` + `synthesizeWithFollowup` + ctx-field fan-in.
- For real graphs (8+ nodes, multiple cross-edges), users should reach for Temporal / LangGraph / Inngest, importing thread-phase for the agent loops inside each node.

The cleanest position: **thread-phase is the agent-loop layer, not the orchestration layer.** It composes under those tools rather than replacing them.

### Anthropic native SDK adapter
The README claims "inference-provider agnostic," but the v1 reframing is honest: thread-phase is **OpenAI-compatible**. Anthropic's content-block model is meaningfully different from OpenAI's tool-call model; an adapter would be ~200 LOC of mostly serialization code, and Anthropic's TypeScript SDK already covers that workflow well. Saying "OpenAI-compatible" is a feature for the vLLM/Ollama/llama.cpp user base — most of whom can't or don't want to use the Anthropic SDK.

### Multi-modal inputs (images, audio)
Image/audio in `UserMessage.content` requires the discriminated content-block model that the current `Message` shape avoids. Adoption of multi-modal agents is real but small relative to text-only tool use; the message shape change ripples through compressor, sanitizeToolPairs, and the tool-result types. Defer until a real consumer needs it.

### Distributed JobStore (Postgres / Redis)
The sync `JobStore` interface is locked-in for v1. Migrating to async-everywhere is a major bump that helps no one currently. If somebody needs Postgres-backed jobs (e.g. multi-process workers sharing state), the right move is to add `JobStoreAsync` as a *second* interface and let `JobRunner` accept either. That's an additive change, not breaking.

### Built-in observability (OpenTelemetry, Prometheus)
The activity log + `onStreamEvent` callback give downstream apps everything needed to wire OTel themselves. Building it in would force opinionated dependencies on every user. Out of scope.

### Per-tool concurrency limits / per-tool rate limiting
Useful, but properly belongs in the user's tool implementation (or in their tool registry wrapper). thread-phase already passes the right primitives — `signal`, the `boundedFanout` concurrency cap. Building this in would couple the framework to specific rate-limit semantics.

---

## Design observations (preserved from v0.1 review)

### Patterns are thin — confirmed in production
v0.0.1 review predicted patterns would be small named shapes rather than enforcement points. That held up. `boundedFanout` is the only `patterns/*` helper used heavily by chiya; the rest exist to *name* recurring shapes for callers who want them. The v0.1 cycle added `streamingBoundedFanout` and `parallelPhases` because real production use surfaced the need; we'll add more if downstream pipelines surface more, and not before.

### Same-DB co-tenancy works
chiya runs `ArticleStore` (domain-specific) and `SqliteJobStore` (framework) on the same sqlite file with separate connections. WAL mode handles concurrency cleanly. No locking issues across hundreds of librarian + digest cycles. **Recommended pattern:** let downstream apps store their domain data in the same DB file as the framework's job/event log.

### The split between agent loop and orchestration is the right boundary
v0.1's biggest insight from production: thread-phase's value concentrates in `runAgentWithTools` — the streaming tool-use loop with budget enforcement, cancellation, verifyResult, and the OpenAI adapter. The orchestration layer (`runPipeline`, `JobRunner`) is *also* useful for the standalone case but is opt-in. Users who want only the agent loop can take just that. Users who want a graph framework on top can compose. This separation is a v1 design commitment.

---

## Versioning policy (post-v1)

- **patch (1.0.x)** — bug fixes, no API changes
- **minor (1.x.0)** — additive changes (new patterns, new optional fields, new exports), no breaking changes to anything in the **stable** surface
- **major (x.0.0)** — breaking changes to the stable surface

`@internal` exports are not covered. They may change in any release.

The CHANGELOG is the canonical place to read what changed and why. The ROADMAP is forward-looking only.
