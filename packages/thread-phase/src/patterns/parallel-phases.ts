/**
 * parallel-phases — run several phases concurrently as one composite phase.
 *
 * The framework treats pipelines as an ordered array, which covers linear
 * flow, conditional skip (`intentGate`), and self-iteration
 * (`whileCondition`). The one DAG shape it doesn't natively express is
 * "run two independent branches at the same time, then continue when
 * both finish." That's what this pattern is for.
 *
 * Semantics:
 *   - Sub-phases share the parent `ctx`. If two branches both write to the
 *     same field, last-write-wins. Keep branches' ctx writes disjoint.
 *   - Events from all branches interleave into the composite phase's
 *     output stream in arrival order.
 *   - If a sub-phase throws, sibling branches are cooperatively cancelled
 *     via an internal `AbortSignal` composed onto each branch's `ctx.signal`.
 *     Siblings still need to OBSERVE their signal to short-circuit awaits —
 *     between yields they bail immediately via the queue's error flag.
 *   - If the outer `ctx.signal` aborts, every branch's composed signal
 *     aborts too. The composite then re-throws the first error encountered
 *     (or the outer abort).
 *   - If a sub-phase sets `ctx.stop`, sibling branches still run to
 *     completion. The orchestrator's stop check fires AFTER the composite
 *     phase returns, halting subsequent top-level phases.
 *
 * For data-dependent fan-in, write each branch's output to a distinct ctx
 * field; a downstream phase reads them all via `requireCtx`. That's a
 * complete DAG-edge expression without a graph framework.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';

export function parallelPhases<
  TCtx extends BasePipelineContext,
  TEvent = PipelineEvent,
>(
  phaseName: string,
  phases: ReadonlyArray<Phase<TCtx, TEvent>>,
): Phase<TCtx, TEvent> {
  return {
    name: phaseName,
    async *run(ctx) {
      if (phases.length === 0) return;

      // Internal controller fans cancellation across branches. When one
      // branch throws (or the outer ctx.signal aborts), every other branch
      // sees its composed ctx.signal flip to aborted — they can observe it
      // in their inner await loops to bail cooperatively.
      const internal = new AbortController();
      const outerSignal = ctx.signal;
      const composedSignal = outerSignal
        ? AbortSignal.any([outerSignal, internal.signal])
        : internal.signal;

      const onOuterAbort = (): void => internal.abort(outerSignal!.reason);
      if (outerSignal && !outerSignal.aborted) {
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      } else if (outerSignal?.aborted) {
        internal.abort(outerSignal.reason);
      }

      // Producer/consumer: each sub-phase pushes events into a shared queue;
      // the composite generator drains the queue and yields downstream.
      const queue: TEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      const wake = () => {
        const fn = resolveWaiter;
        resolveWaiter = null;
        fn?.();
      };
      const wait = () => new Promise<void>((r) => (resolveWaiter = r));

      let errored: unknown = null;
      let running = phases.length;

      const drain = async (phase: Phase<TCtx, TEvent>): Promise<void> => {
        // Each branch sees the composed signal, not the outer's directly,
        // so sibling errors propagate as cancellation through ctx.signal.
        const branchCtx = withSignal(ctx, composedSignal);
        try {
          for await (const ev of phase.run(branchCtx)) {
            queue.push(ev);
            wake();
            // Do not short-circuit on `errored` — that would close the
            // branch's generator before it had a chance to observe
            // composedSignal cooperatively. Branches that check c.signal
            // bail themselves; branches that don't run to completion (the
            // documented cooperative-cancellation contract).
          }
        } catch (err) {
          if (!errored) {
            errored = err;
            // First error fires the internal abort so siblings cancel too.
            internal.abort(err);
          }
        } finally {
          running--;
          wake();
        }
      };

      const allDone = Promise.all(phases.map(drain));

      try {
        while (running > 0 || queue.length > 0) {
          if (queue.length === 0) {
            await Promise.race([wait(), allDone]);
            continue;
          }
          yield queue.shift()!;
        }

        await allDone;
        if (errored) throw errored;
      } finally {
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      }
    },
  };
}

/**
 * Build a per-branch ctx view whose `signal` is the composed signal.
 * Other fields share the parent ctx (last-write-wins semantics preserved).
 */
function withSignal<TCtx extends BasePipelineContext>(
  ctx: TCtx,
  signal: AbortSignal,
): TCtx {
  // A Proxy keeps writes to ctx visible across all branches (the documented
  // last-write-wins model) while masking `signal` to the composed value.
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'signal') return signal;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === 'signal') return true; // ignore writes to branch-local signal
      return Reflect.set(target, prop, value, receiver);
    },
  }) as TCtx;
}
