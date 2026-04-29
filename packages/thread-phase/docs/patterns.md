# Patterns selection guide

thread-phase's `patterns/*` are *named shapes*, not abstractions you have to satisfy. Each is a small helper (38-220 LOC) capturing a recurring structure we hit in real pipelines. Pick by starting from "what shape does my problem have?", not "which framework feature should I use?"

## Quick reference

| I want to... | Use | When **not** to use |
|---|---|---|
| Run an agent per item over a list, capped concurrency | [`boundedFanout`](#boundedfanout) | List has ≤2 items (just `Promise.all`) |
| Same, but show progress as items finish | [`streamingBoundedFanout`](#streamingboundedfanout) | You only care about final results |
| Run agents in parallel without a concurrency cap | [`parallelFanout`](#parallelfanout) | More than ~10 items (use `boundedFanout`) |
| Run several distinct phases concurrently | [`parallelPhases`](#parallelphases) | Phases share mutable state on the same ctx field |
| Cheaply decide whether the rest of the pipeline should run | [`intentGate`](#intentgate) | The check is itself expensive — just write the phase directly |
| Score feasibility before spending big-model tokens | [`preflightConfidence`](#preflightconfidence) | You don't have a cheap signal to score on |
| Have a synthesizer review its own output and request another round | [`synthesizeWithFollowup`](#synthesizewithfollowup) | The follow-up doesn't re-run upstream work — just call again |
| Verify a sample of typed claims from prior output | [`spotCheck`](#spotcheck) | You need to verify *every* claim, not a sample |

---

## `boundedFanout`

**Shape:** N items → one async runner per item → results array, max K runners in flight.

**When to use:** the canonical batch shape. Inference backends have hard concurrency caps (e.g. vLLM's `--max-num-seqs`); sending 200 requests at once when the server decodes 4 doesn't help. Match concurrency to the real bottleneck and observe per-item completion via `onItemDone`.

**When not to use:** if your list is already small (≤2 items), `Promise.all` is shorter. If you want progress visibility *during* the fanout, use `streamingBoundedFanout` instead.

**Failure semantics:** mirrors `Promise.all` — first thrown error rejects the whole call; in-flight runners complete but their results are discarded. Wrap your runner with try/catch if you want partial-results-on-failure.

[Source](../src/patterns/bounded-fanout.ts) · 80 LOC

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
