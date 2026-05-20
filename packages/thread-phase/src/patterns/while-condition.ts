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

import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';

export interface WhileConditionOptions<TCtx extends BasePipelineContext> {
  /** Predicate evaluated before each iteration. Loop continues while true. */
  predicate: (ctx: TCtx) => boolean | Promise<boolean>;
  /** Phases to run each iteration. */
  body: Phase<TCtx>[];
  /** Hard cap on iterations to prevent runaway loops. Default: 10. */
  maxIterations?: number;
}

export function whileCondition<TCtx extends BasePipelineContext>(
  phaseName: string,
  options: WhileConditionOptions<TCtx>,
): Phase<TCtx> {
  const max = options.maxIterations ?? 10;

  return {
    name: phaseName,
    async *run(ctx) {
      let iterations = 0;

      while (iterations < max) {
        const shouldContinue = await options.predicate(ctx);
        if (!shouldContinue) {
          yield {
            type: 'data',
            key: `${phaseName}.converged`,
            value: { iterations },
          };
          return;
        }

        yield {
          type: 'agent_activity',
          agent: phaseName,
          action: 'iteration',
          detail: `${iterations + 1}/${max}`,
        };

        for (const phase of options.body) {
          yield* phase.run(ctx);
          if (ctx.stop) return;
        }

        iterations++;
      }

      yield {
        type: 'data',
        key: `${phaseName}.max-iterations`,
        value: { iterations },
      };
      ctx.stop = { reason: `${phaseName}: max iterations (${max}) reached` };
    },
  };
}
