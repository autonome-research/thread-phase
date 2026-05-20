/**
 * match — keyed dispatch over phases.
 *
 * Routes to one of N phase lists based on a selector function. Generalizes
 * if/else (use two cases) and replaces ad-hoc switch statements in pipeline
 * code with a primitive the orchestrator can reason about.
 *
 * The selector returns one of three things:
 *  - a key present in `cases`             → run that case's phases
 *  - a key missing from `cases`           → run `default` if provided, else skip
 *  - `null`                               → skip silently (no case, no default)
 *
 * Emits a `data` event with key `${name}.taken` and value
 * `{ taken: key | 'default' | 'skip' }` so downstream consumers can tell
 * which arm ran without inspecting the selector themselves.
 *
 * Strict dispatch is the caller's responsibility — assert inside the
 * selector if a missing key should be a bug.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';

export interface MatchOptions<TCtx extends BasePipelineContext, K extends string> {
  /** Returns the key of the case to run, or null to skip. */
  selector: (ctx: TCtx) => K | null | Promise<K | null>;
  /** Phase lists keyed by case. */
  cases: Record<K, Phase<TCtx>[]>;
  /** Fallback phases when selector returns a key not in `cases`. */
  default?: Phase<TCtx>[];
}

export function match<TCtx extends BasePipelineContext, K extends string>(
  phaseName: string,
  options: MatchOptions<TCtx, K>,
): Phase<TCtx> {
  return {
    name: phaseName,
    async *run(ctx) {
      const key = await options.selector(ctx);

      let chosen: Phase<TCtx>[] | undefined;
      let taken: string;

      if (key === null) {
        chosen = undefined;
        taken = 'skip';
      } else if (Object.prototype.hasOwnProperty.call(options.cases, key)) {
        chosen = options.cases[key];
        taken = key;
      } else if (options.default) {
        chosen = options.default;
        taken = 'default';
      } else {
        chosen = undefined;
        taken = 'skip';
      }

      yield {
        type: 'data',
        key: `${phaseName}.taken`,
        value: { taken },
      };

      if (!chosen) return;

      for (const phase of chosen) {
        yield* phase.run(ctx);
        if (ctx.stop) return;
      }
    },
  };
}
