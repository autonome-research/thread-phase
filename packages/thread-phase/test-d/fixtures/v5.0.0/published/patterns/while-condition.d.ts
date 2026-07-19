/**
 * while-condition — a general convergence loop.
 *
 * Runs `body` repeatedly while `predicate(ctx)` is true, capped at
 * `maxIterations`. Predicate is async and runs *before* each iteration —
 * an immediately-false predicate produces zero body executions, like a
 * standard `while` loop.
 *
 * Exits via one of:
 *  - predicate returns false       → emits a `data` event with key
 *                                    `${name}.converged` and value
 *                                    `{ iterations }`.
 *  - maxIterations reached         → sets ctx.stop with a reason naming
 *                                    the pattern; emits `data` event
 *                                    `${name}.max-iterations`.
 *  - body sets ctx.stop            → propagates immediately.
 *
 * Body composition: pass a list of phases — they run in order each
 * iteration, sharing ctx. Use `parallelPhases` if you want them concurrent.
 */
import type { BasePipelineContext, Phase } from '../phase.js';
export interface WhileConditionOptions<TCtx extends BasePipelineContext> {
    /** Predicate evaluated before each iteration. Loop continues while true. */
    predicate: (ctx: TCtx) => boolean | Promise<boolean>;
    /** Phases to run each iteration. */
    body: Phase<TCtx>[];
    /** Hard cap on iterations to prevent runaway loops. Default: 10. */
    maxIterations?: number;
}
export declare function whileCondition<TCtx extends BasePipelineContext>(phaseName: string, options: WhileConditionOptions<TCtx>): Phase<TCtx>;
//# sourceMappingURL=while-condition.d.ts.map