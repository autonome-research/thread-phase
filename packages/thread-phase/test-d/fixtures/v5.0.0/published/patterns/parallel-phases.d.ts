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
export declare function parallelPhases<TCtx extends BasePipelineContext, TEvent = PipelineEvent>(phaseName: string, phases: ReadonlyArray<Phase<TCtx, TEvent>>): Phase<TCtx, TEvent>;
//# sourceMappingURL=parallel-phases.d.ts.map