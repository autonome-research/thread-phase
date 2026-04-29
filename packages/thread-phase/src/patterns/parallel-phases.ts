/**
 * parallel-phases — run several phases concurrently as one composite phase.
 *
 * The framework treats pipelines as an ordered array, which covers linear
 * flow, conditional skip (`intentGate`), and self-iteration
 * (`synthesizeWithFollowup`). The one DAG shape it doesn't natively express
 * is "run two independent branches at the same time, then continue when
 * both finish." That's what this pattern is for.
 *
 * Semantics:
 *   - Sub-phases share the parent `ctx`. If two branches both write to the
 *     same field, last-write-wins. Keep branches' ctx writes disjoint.
 *   - Events from all branches interleave into the composite phase's
 *     output stream in arrival order.
 *   - If a sub-phase throws, the composite re-throws (after letting other
 *     branches finish what they're doing — no in-flight cancellation).
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
        try {
          for await (const ev of phase.run(ctx)) {
            queue.push(ev);
            wake();
            if (errored) return;
          }
        } catch (err) {
          if (!errored) errored = err;
        } finally {
          running--;
          wake();
        }
      };

      const allDone = Promise.all(phases.map(drain));

      while (running > 0 || queue.length > 0) {
        if (errored && queue.length === 0) break;
        if (queue.length === 0) {
          await Promise.race([wait(), allDone]);
          continue;
        }
        yield queue.shift()!;
      }

      await allDone;
      if (errored) throw errored;
    },
  };
}
