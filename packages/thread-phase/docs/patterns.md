# Patterns selection guide

thread-phase's `patterns/*` are *named shapes*, not abstractions you have to satisfy. Each is a small helper (38-220 LOC) capturing a recurring structure we hit in real pipelines. Pick by starting from "what shape does my problem have?", not "which framework feature should I use?"

## Quick reference

| I want to... | Use | When **not** to use |
|---|---|---|
| Run a free-function runner per item over a list, capped concurrency | [`boundedFanout`](#boundedfanout) | List has ≤2 items (just `Promise.all`); the runner is an `AgentAdapter` and you want bus propagation |
| Run an `AgentAdapter` per item with shared event-bus propagation | [`boundedFanoutOf`](#boundedfanoutof) | The runner isn't adapter-shaped; you want a free-function callback |
| Same as boundedFanout, but show progress as items finish | [`streamingBoundedFanout`](#streamingboundedfanout) | You only care about final results |
| Run agents in parallel without a concurrency cap | [`parallelFanout`](#parallelfanout) | More than ~10 items (use `boundedFanout`) |
| Run several distinct phases concurrently | [`parallelPhases`](#parallelphases) | Phases share mutable state on the same ctx field |
| Cheaply decide whether the rest of the pipeline should run | [`intentGate`](#intentgate) | The check is itself expensive — just write the phase directly |
| Score feasibility before spending big-model tokens | [`preflightConfidence`](#preflightconfidence) | You don't have a cheap signal to score on |
| Have a synthesizer review its own output and request another round | [`synthesizeWithFollowup`](#synthesizewithfollowup) | The follow-up doesn't re-run upstream work — just call again |
| Verify a sample of typed claims from prior output | [`spotCheck`](#spotcheck) | You need to verify *every* claim, not a sample |
| Loop a body of phases while some condition holds | [`whileCondition`](#whilecondition) | The loop body re-runs upstream work with a structured directive — use `synthesizeWithFollowup` |
| Route to one of N phase lists based on a key | [`match`](#match) | The dispatch is a single async classifier with a halt option — use `intentGate` |
| Retry a flaky phase with exponential backoff | [`withRetry`](#withretry) | The work isn't idempotent — fix that first, or pass `resetState` |

---

## `boundedFanout`

**Shape:** N items → one async runner per item → results array, max K runners in flight.

**When to use:** the canonical batch shape. Inference backends have hard concurrency caps (e.g. vLLM's `--max-num-seqs`); sending 200 requests at once when the server decodes 4 doesn't help. Match concurrency to the real bottleneck and observe per-item completion via `onItemDone`.

**When not to use:** if your list is already small (≤2 items), `Promise.all` is shorter. If you want progress visibility *during* the fanout, use `streamingBoundedFanout` instead.

**Failure semantics:** mirrors `Promise.all` — first thrown error rejects the whole call; in-flight runners complete but their results are discarded. Wrap your runner with try/catch if you want partial-results-on-failure.

[Source](../src/patterns/bounded-fanout.ts) · 80 LOC

---

## `boundedFanoutOf`

**Shape:** N items → `AgentAdapter` + `buildConfig` per item → `AgentRunResult[]` in input order, max K runs in flight.

**When to use:** the canonical batch shape when each item should run through an adapter (`claudeCodeAgent`, `hermesAgent`, `codexAgent`, etc.) rather than a free-function runner. The pattern wires `options.eventBus` and `options.signal` automatically so every parallel adapter run lands events on one shared bus and cancellation propagates with one signal. Result type discriminates on `mode`: default `'fail-fast'` rejects with `BoundedFanoutOfError` on the first error; `'collect'` returns the full `AgentRunResult[]` with failed items having `finishReason: 'error'`.

**When not to use:** when your runner is a free function (HTTP call, `runAgentWithTools` with custom verification, etc.) — `boundedFanout`'s callback form is more direct. If you have only one item, just call the adapter directly.

**Failure semantics:** `'fail-fast'` aborts all in-flight runs on the first failure via `controller.abort()` and `run.abort()` (belt-and-suspenders) and rejects with `BoundedFanoutOfError { itemIndex, result }`. `'collect'` continues through failures; items not dispatched before a signal abort get synthetic `'aborted'` slots in the result array to preserve position stability.

```ts
import { boundedFanoutOf } from 'thread-phase/patterns';
import { claudeCodeAgent } from 'thread-phase-agents';

const results = await boundedFanoutOf({
  items: filesToReview,
  concurrency: 3,
  adapter: claudeCodeAgent,
  buildConfig: (file) => ({ cwd: '/repo', prompt: `Review ${file}` }),
  eventBus: ctx.bus,
  signal: ctx.signal,
  mode: 'collect',
});
```

[Source](../src/patterns/bounded-fanout-of.ts) · ~190 LOC

---

## `streamingBoundedFanout`

**Shape:** same scheduling as `boundedFanout`, but yields `item_done` events as items complete plus a final `done` event with the ordered results.

**When to use:** inside a phase where you want progress visibility *during* a long fanout (5-15 min wall time). Use this anywhere you'd otherwise emit milestone events post-hoc — it lets the phase yield real-time progress through the pipeline event stream.

**When not to use:** if you only care about final results, `boundedFanout` is simpler. Don't use both — pick one.

[Source](../src/patterns/bounded-fanout.ts) · 130 LOC (combined)

---

## `parallelFanout`

**Shape:** N items → `Promise.all` of runner per item.

**When to use:** small lists (≤10 items) where the inference backend can handle the load and concurrency capping is overhead. Useful for a handful of independent phase calls.

**When not to use:** when you have ≥10 items, or when running against a backend with a hard concurrency cap. `boundedFanout` strictly dominates in those cases.

[Source](../src/patterns/parallel-fanout.ts) · 38 LOC

---

## `parallelPhases`

**Shape:** several `Phase`s → one composite `Phase` that runs them concurrently and merges their event streams.

**When to use:** the array-of-phases model handles linear flow; this is for the one DAG shape it can't express naturally — "run two independent branches at the same time, then continue when both finish." Each branch writes to a distinct `ctx` field; a downstream phase reads them all via `requireCtx`.

**When not to use:** if branches share mutable state on the same ctx field (last-write-wins, easy to hit a race). If you find yourself nesting `parallelPhases` inside `parallelPhases` repeatedly, your pipeline is graph-shaped enough that you should consider Temporal/LangGraph for orchestration and import thread-phase for the agent loops inside each node.

**Failure semantics:** first error from any branch propagates; siblings keep running but their events after the error are discarded. `ctx.stop` set by one branch does NOT cancel siblings — they run to completion, and the orchestrator's stop check fires after the composite returns.

[Source](../src/patterns/parallel-phases.ts) · 80 LOC

---

## `intentGate`

**Shape:** cheap classifier → either continue the pipeline or short-circuit with an optional handler.

**When to use:** the canonical cost-control phase. A 1-call cheap classifier decides whether the rest of the pipeline (heavy synthesis, multi-tool agents) should run, or whether a much cheaper path applies. Common: "if the input isn't in our corpus, skip the agent pipeline."

**When not to use:** if the check itself is expensive (more than a few hundred tokens). At that point write a regular phase that mutates `ctx` and conditionally sets `ctx.stop` — `intentGate`'s value is in giving the cheap-check pattern a name.

[Source](../src/patterns/intent-gate.ts) · 62 LOC

---

## `preflightConfidence`

**Shape:** cheap signal → typed score → optionally halt if the score is too low.

**When to use:** before spending big-model tokens on heavy work, score feasibility from cheaper signals (metadata, small-model output, fast retrieval count). Useful when you have a fast pre-check that can detect "not enough material to work with" cases before paying for the heavy step.

**When not to use:** when you don't have a cheap-to-compute signal. The pattern only earns its keep when the assess step is meaningfully cheaper than the work you'd skip.

[Source](../src/patterns/preflight-confidence.ts) · 61 LOC

---

## `synthesizeWithFollowup`

**Shape:** synthesizer produces draft → inspect for "I need more on X" → if present and budget allows, re-run upstream phases → loop, capped at `maxIterations`.

**When to use:** when the synthesizer's output gives you a structured signal that more upstream work is needed — typically because it discovered a citation gap, a missing data slice, or unresolved ambiguity. The follow-up directive is a typed value the synthesizer emits; `doFollowUp` is whatever upstream phases re-run.

**When not to use:** when the follow-up is just "ask again with the same inputs" — that's a retry, not a re-run. Direct `runAgentWithTools` calls in a loop are simpler.

[Source](../src/patterns/synthesize-with-followup.ts) · 79 LOC

---

## `spotCheck`

**Shape:** extract claims from a prior phase → verify a capped sample in parallel → stash results.

**When to use:** when a synthesis or report produces typed claims (citations, data points, generated paths) and you want defensive verification without paying to verify every one. Sample N claims, run a verification agent on each, stash results — the cost-controlled alternative to full verification.

**When not to use:** when every claim must be verified — sampling defeats the purpose. Run the verifier on the full set instead, ideally via `boundedFanout`.

[Source](../src/patterns/spot-check.ts) · 57 LOC

---

## `whileCondition`

**Shape:** async predicate → if true, run body phases; if false, exit. Capped at `maxIterations`.

**When to use:** the canonical convergence-loop pattern. Common: "keep searching until ctx.sufficient", "iterate refinement until the verifier passes", "drain a queue while it's non-empty." Predicate runs *before* each iteration (like `while`, not `do/while`), so an initially-false predicate produces zero body runs.

**When not to use:** if the loop body is "re-run a specific synthesizer with a typed follow-up directive", `synthesizeWithFollowup` is the more specific shape. If you need an unconditional N-iteration loop, just write a `for` loop in TypeScript.

**Failure semantics:** body sets `ctx.stop` → loop halts immediately. Max iterations reached → loop sets `ctx.stop` with a reason naming the pattern. Predicate throws → propagates as an uncaught error.

```ts
import { whileCondition } from '@autonome-research/thread-phase/patterns';

const research = whileCondition<ResearchCtx>('research-loop', {
  predicate: (ctx) => !ctx.sufficient,
  body: [searchPhase, assessPhase],
  maxIterations: 5,
});
```

[Source](../src/patterns/while-condition.ts) · ~70 LOC

---

## `match`

**Shape:** selector returns a key → run the corresponding case's phases. `null` skips silently. Missing keys fall through to `default` or skip if no default.

**When to use:** any time the next set of phases depends on a discriminated value already in ctx — issue type, document format, retrieval strategy. Strictly more general than if/else; for two-case dispatch, write `selector: (ctx) => ctx.x === 'a' ? 'a' : 'b'`.

**When not to use:** for "cheap classifier + early-halt" — that's exactly what `intentGate` does, with halt-via-`ctx.stop` baked in. `match` is the pure routing primitive without classification or halt semantics.

**Failure semantics:** a case sets `ctx.stop` → composite halts immediately. The pattern itself never throws; assert in your selector if a missing key should be a bug. Emits a `data` event with key `${name}.taken` and value `{ taken: key | 'default' | 'skip' }` so consumers can observe routing without re-running the selector.

```ts
import { match } from '@autonome-research/thread-phase/patterns';

const triage = match<TriageCtx, 'bug' | 'feature' | 'question'>('triage', {
  selector: (ctx) => ctx.intent ?? null,
  cases: {
    bug: [reproducePhase, assignEngineer],
    feature: [triagePhase],
    question: [respondFaqPhase],
  },
  default: [escalatePhase],
});
```

[Source](../src/patterns/match.ts) · ~70 LOC

---

## `withRetry`

**Shape:** higher-order wrapper that retries a phase on failure with exponential backoff.

**When to use:** wrap flaky individual phases — inference calls against rate-limited endpoints, network-dependent retrievals, anything where transient failure is meaningful. Retries on both thrown exceptions and clean `ctx.stop` signals; override with `isFailure` if some stop reasons should not be retried (e.g. user cancellation).

**When not to use:** when the inner phase isn't idempotent and you don't have a `resetState` hook to undo partial work. A failed attempt may have mutated ctx; the wrapper does not snapshot/restore by default — that's the caller's responsibility. Also skip for non-retryable failures (validation errors, schema mismatches, permanent auth failures) — use `isFailure` or a separate error path.

**Failure semantics:** attempt budget exhausted → re-throws the last thrown error, or leaves `ctx.stop` set if the inner used the stop signal. Each retry clears `ctx.stop` before the next inner run and applies exponential backoff (`baseDelayMs × 2^(attempt-1)`).

```ts
import { withRetry } from '@autonome-research/thread-phase/patterns';

const reliableSearch = withRetry(searchPhase, {
  maxAttempts: 5,
  baseDelayMs: 1000,
  isFailure: (ctx, err) =>
    err !== undefined || (ctx.stop?.reason !== 'user-cancelled' && !!ctx.stop),
});
```

[Source](../src/patterns/with-retry.ts) · ~95 LOC

---

## When none of these fit

Patterns are convenience, not requirement. If your problem doesn't match one of these shapes, just write a `Phase` directly:

```ts
const myPhase: Phase<MyCtx> = {
  name: 'my-phase',
  async *run(ctx) {
    yield { type: 'phase', phase: 'my-phase', detail: 'starting' };
    const data = requireCtx(ctx, 'upstream', 'my-phase');
    const result = await doTheWork(data);
    ctx.myOutput = result;
    yield { type: 'data', key: 'my-phase', value: result };
  },
};
```

Then plug it into `runPipeline([phaseA, myPhase, phaseC], ctx)`. No registration, no plugin system. The patterns exist to *name* recurring shapes — they don't gate access to anything.
