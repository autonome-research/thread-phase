/**
 * Shared user-side pattern — pollUntil.
 *
 * Wraps `whileCondition` to express "keep polling X until condition Y".
 * Not registered (it's not an extension surface), just imported by any
 * pipeline file that wants the shape.
 *
 * Files under `.thread-phase/lib/` are the conventional home for shared
 * user-side code — custom patterns, shared types, helpers used by more
 * than one pipeline. They are NOT auto-loaded; they're imported via
 * relative paths from triggers/adapters/pipelines.
 */

import { whileCondition } from '@autonome-research/thread-phase/patterns';
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';

export interface PollUntilOptions<TCtx extends BasePipelineContext> {
  /** Probe phase — should mutate ctx with the latest observation. */
  probe: Phase<TCtx>;
  /** Predicate evaluated after each probe; loop exits when it returns true. */
  done: (ctx: TCtx) => boolean | Promise<boolean>;
  /** Hard cap on poll iterations. Default: 20. */
  maxIterations?: number;
}

/**
 * Build a Phase that re-runs `probe` until `done(ctx)` is true (or the cap
 * trips). Emits a `${name}.converged` data event when it settles.
 */
export function pollUntil<TCtx extends BasePipelineContext>(
  name: string,
  options: PollUntilOptions<TCtx>,
): Phase<TCtx> {
  return whileCondition<TCtx>(name, {
    predicate: async (ctx) => !(await options.done(ctx)),
    body: [options.probe],
    maxIterations: options.maxIterations ?? 20,
  });
}
