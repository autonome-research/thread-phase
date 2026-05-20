# Recipes

The v3.0.0 release trimmed five patterns from `patterns/*` whose shapes were
better expressed as compositions of the seven kept patterns (or, in one case,
of a single Node primitive). This file is the migration guide: each removed
pattern is shown as a recipe you can paste in.

If you were importing one of the deleted names, you have two options:

1. Pin to `2.x` if you have many call sites — `2.5.0` is the last release
   shipping all 12 patterns.
2. Migrate to the recipe form below — usually 3–10 lines of inline code with
   no loss of expressiveness.

The kept seven patterns:

- [`boundedFanout`](./patterns.md#boundedfanout)
- [`boundedFanoutOf`](./patterns.md#boundedfanoutof)
- [`parallelPhases`](./patterns.md#parallelphases)
- [`intentGate`](./patterns.md#intentgate)
- [`whileCondition`](./patterns.md#whilecondition)
- [`match`](./patterns.md#match)
- [`withRetry`](./patterns.md#withretry)

(Plus `subPipeline`, which composes whole pipelines.)

---

## Uncapped parallel fanout (was `parallelFanout`)

**Original shape:** N items → one async runner per item → results in input
order. No concurrency cap.

**Why it was removed:** it's a one-line wrapper over `Promise.all`. Naming a
pattern for "call `Promise.all`" adds an import without adding meaning.

**Recipe — just use `Promise.all`:**

```ts
const items = ['a', 'b', 'c'];
const results = await Promise.all(items.map((item, i) => runner(item, i)));
```

If you previously used `maxItems` to cap input length, slice before mapping:

```ts
const results = await Promise.all(items.slice(0, 5).map((item, i) => runner(item, i)));
```

**If you have a real concurrency cap** (e.g. a vLLM `--max-num-seqs` of 4),
you wanted `boundedFanout` all along — uncapped parallelism past the
server's decode width is wasted scheduling. Switch to `boundedFanout` with
`concurrency: <server cap>`.

---

## Streaming bounded fanout (was `streamingBoundedFanout`)

**Original shape:** same scheduling as `boundedFanout`, but yielded as an
`AsyncGenerator` of `item_done` / `item_error` events with a terminal
`done` / `done_collected` event carrying the full ordered results.

**Why it was removed:** `boundedFanout` already accepts `onItemDone` and
`onItemError` callbacks that fire in completion order with the same data
(item, index, result/error). The generator wrapping was extra surface area
for a callback that already existed.

**Recipe — use `boundedFanout` with `onItemDone` and emit events from there:**

```ts
import { boundedFanout } from '@autonome-research/thread-phase/patterns';

async function* phaseBody(ctx: MyCtx) {
  const itemEvents: Array<{ index: number; result: TResult }> = [];

  const results = await boundedFanout({
    items: ctx.items,
    concurrency: 4,
    runner: (item, _i, signal) => runOne(item, signal),
    onItemDone: ({ item, index, result }) => {
      itemEvents.push({ index, result });
    },
    onItemError: ({ item, index, error }) => {
      // log per-item error in 'collect' mode
    },
    mode: 'collect',
    signal: ctx.signal,
  });

  // After fanout completes, emit the events in completion order.
  for (const ev of itemEvents) {
    yield {
      type: 'data',
      key: `item.${ev.index}.done`,
      value: { result: ev.result },
    };
  }
  yield { type: 'data', key: 'fanout.done', value: { count: results.length } };
}
```

If you genuinely need events to be yielded *during* the fanout (not after),
push from `onItemDone` into a queue and yield from the queue in a parallel
loop — but in practice the post-hoc emit above is what every real consumer
needed.

---

## Preflight confidence score (was `preflightConfidence`)

**Original shape:** cheap `assess(ctx)` returns a typed score; `writeTo`
stashes it on ctx; `stopIf(score)` returns a string to halt the pipeline.

**Why it was removed:** it's `intentGate` with a scoring classifier. The
gate already has `onLowConfidence` and ctx.stop semantics; the only thing
this pattern added was a `describe(score)` helper, which is one extra line.

**Recipe — use `intentGate` with the score-as-classification shape:**

```ts
import { intentGate } from '@autonome-research/thread-phase/patterns';

const preflight = intentGate<MyCtx>('preflight-feasibility', {
  classify: async (ctx) => {
    const score = await cheapScoreCall(ctx.input); // your scoring function
    return {
      intent: score >= 0.5 ? 'feasible' : 'infeasible',
      confidence: score, // 0..1 — used by intentGate's threshold check
      detail: `score=${score.toFixed(2)}`,
    };
  },
  decide: ({ intent, confidence }) => {
    // Halt the pipeline if the score is below threshold.
    if (intent === 'infeasible') {
      return { kind: 'stop', reason: `insufficient signal (score=${confidence.toFixed(2)})` };
    }
    return { kind: 'continue' };
  },
  writeTo: (ctx, classification) => {
    ctx.feasibilityScore = classification.confidence;
  },
});
```

The `writeTo` hook is the equivalent of the original `writeTo`; `decide`
returning `{ kind: 'stop', reason }` is the equivalent of the original
`stopIf`. If you don't need to stop and just want to record the score,
write a plain `Phase` directly — `intentGate` only earns its keep when
the score gates downstream work.

---

## Spot-check claims (was `spotCheck`)

**Original shape:** `extractClaims(ctx)` returns a list; cap to `maxClaims`;
`verify(claim, ctx)` runs per claim in parallel; `writeTo` stashes the
results.

**Why it was removed:** `boundedFanout` over a sliced array does this in
three lines. The pattern added `extractClaims` and `writeTo` as named hooks,
but those are just `ctx.claims = extract()` and `ctx.verified = results` —
plain assignment in a phase body.

**Recipe — `boundedFanout` over the sampled subset:**

```ts
import { boundedFanout } from '@autonome-research/thread-phase/patterns';
import type { Phase } from '@autonome-research/thread-phase';

const spotCheckPhase: Phase<MyCtx> = {
  name: 'spot-check',
  async *run(ctx) {
    const allClaims = ctx.synthesis.claims;
    const sample = allClaims.slice(0, 5); // your sampling logic

    yield {
      type: 'phase',
      phase: 'spot-check',
      detail: `verifying ${sample.length}/${allClaims.length} claims`,
    };

    if (sample.length === 0) {
      ctx.verifications = [];
      return;
    }

    ctx.verifications = await boundedFanout({
      items: sample,
      concurrency: 3,
      runner: (claim) => verifyOneClaim(claim, ctx),
    });
  },
};
```

For random sampling instead of head-of-list, swap `slice(0, 5)` for your
sampler of choice. For weighted verification (e.g. verify all
high-confidence-but-novel claims, sample the rest), filter then concat
before passing to `boundedFanout`.

---

## Synthesizer with structured follow-up (was `synthesizeWithFollowup`)

**Original shape:** synthesizer yields events and returns final text;
`extractFollowUp(output)` returns null or a typed directive; `doFollowUp`
re-runs upstream phases; loop until null or `maxIterations`.

**Why it was removed:** it's `whileCondition` with a body that runs the
synthesizer and follow-up, plus a predicate that reads the
just-produced follow-up directive off ctx. The dedicated pattern hid the
loop structure behind generator gymnastics; the recipe form makes the
control flow plain.

**Recipe — `whileCondition` with the synth+critic body and a predicate
reading critic output:**

```ts
import { whileCondition } from '@autonome-research/thread-phase/patterns';
import type { Phase } from '@autonome-research/thread-phase';

interface SynthCtx extends BasePipelineContext {
  draft?: string;
  followUp?: FollowUpDirective | null; // null = done
  // ... upstream-phase fields the follow-up may refresh
}

const synthPhase: Phase<SynthCtx> = {
  name: 'synthesize',
  async *run(ctx) {
    const result = await runSynthesizer(ctx);
    ctx.draft = result.text;
    ctx.followUp = extractFollowUp(result.text); // null if no follow-up needed
    yield { type: 'data', key: 'draft', value: result.text };
  },
};

const followUpPhase: Phase<SynthCtx> = {
  name: 'follow-up',
  async *run(ctx) {
    if (!ctx.followUp) return; // first iteration: nothing to refresh
    yield* doFollowUp(ctx, ctx.followUp); // re-run whatever upstream needs refreshing
  },
};

const synthesizeWithFollowupRecipe = whileCondition<SynthCtx>('synth-loop', {
  predicate: (ctx) =>
    // First iteration: followUp is undefined → run body once.
    // Subsequent iterations: followUp is set if synth requested more work.
    ctx.followUp === undefined || ctx.followUp !== null,
  body: [followUpPhase, synthPhase], // follow-up first (no-op on first pass), then synth
  maxIterations: 3,
});
```

The key insight: the predicate reads `ctx.followUp` (written by the
synthesizer's last iteration). The body orders `followUpPhase` before
`synthPhase` so the first iteration's follow-up phase is a no-op and the
synth runs first; subsequent iterations re-run upstream then re-synthesize.

For the simpler "synth once, critique, maybe synth again" case where the
critic is part of the synth phase, you can skip the separate follow-up
phase entirely and just put a single combined phase in the body that
mutates `ctx.followUp` at the end.

---

## When you actually need the old pattern back

These recipes cover every use case the deleted patterns covered. If you
hit a case where the recipe form is meaningfully worse than the original
pattern — not just "more lines" but "lost a real semantic guarantee" —
open an issue. The patterns directory is deliberately small; we'd rather
add back a pattern with a clear earning case than carry dead weight.
