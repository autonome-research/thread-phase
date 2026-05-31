/**
 * with-retry — higher-order phase wrapper for retrying flaky work.
 *
 * Wraps any `Phase` and retries it on failure. Failure means either:
 *  - the inner phase throws an exception, OR
 *  - the inner phase yields then sets `ctx.stop` (a clean failure signal)
 *
 * Both default to retryable. Override with `isFailure(ctx, error?)` if a
 * specific `ctx.stop.reason` should *not* trigger a retry (e.g. user
 * cancellation, terminal validation error).
 *
 * Retries are bounded by `maxAttempts` (default 3) and spaced with
 * exponential backoff starting at `baseDelayMs` (default 1000).
 *
 * Idempotence is the caller's responsibility. The wrapper does NOT
 * snapshot/restore ctx between attempts — a partially-applied mutation
 * from a failed attempt is visible to the retry. Pass `resetState` if
 * you need to undo partial work before each retry.
 *
 * Events emitted by the inner phase pass through unmodified. The wrapper
 * additionally emits `data` events with key `${phase.name}.attempt`.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';
import { abortableSleep } from '../internal/sleep.js';

export interface WithRetryOptions<TCtx extends BasePipelineContext> {
  /** Maximum total attempts including the first. Default: 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, in milliseconds. Default: 1000. */
  baseDelayMs?: number;
  /** Decide whether the most recent attempt counts as a failure. Default: ctx.stop is set OR an error was thrown. */
  isFailure?: (ctx: TCtx, error?: unknown) => boolean;
  /** Called before each retry (not before the first attempt). */
  onRetry?: (ctx: TCtx, attempt: number, error?: unknown) => void;
  /** Called between attempts. Use to undo partial mutations from the failed attempt. */
  resetState?: (ctx: TCtx) => void;
}

export function withRetry<TCtx extends BasePipelineContext>(
  phase: Phase<TCtx>,
  options: WithRetryOptions<TCtx> = {},
): Phase<TCtx> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 1000;
  const isFailure =
    options.isFailure ?? ((ctx, error) => error !== undefined || ctx.stop !== undefined);

  return {
    name: phase.name,
    async *run(ctx) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        yield {
          type: 'data',
          key: `${phase.name}.attempt`,
          value: { attempt, maxAttempts },
        };

        const stopBefore = ctx.stop;
        let thrown: unknown = undefined;

        try {
          // Clear ctx.stop so the inner phase has a clean slate; restore on
          // failure-and-retry so we don't leak the previous attempt's signal
          // to the predicate.
          ctx.stop = undefined;
          yield* phase.run(ctx);
        } catch (err) {
          thrown = err;
        }

        const failed = isFailure(ctx, thrown);

        if (!failed) {
          // Success — but only if the inner phase didn't deliberately stop
          // (an isFailure override may treat ctx.stop as success for some
          // reasons; the caller knows best).
          return;
        }

        if (attempt === maxAttempts) {
          // Exhausted — propagate the failure mode the inner phase used.
          if (thrown !== undefined) {
            throw thrown;
          }
          // ctx.stop is already set by the inner phase; leave it.
          return;
        }

        options.onRetry?.(ctx, attempt, thrown);
        ctx.stop = stopBefore; // restore upstream stop, if any
        options.resetState?.(ctx);

        const delay = baseDelay * 2 ** (attempt - 1);
        // ctx.signal is wired by runPipeline; if the caller aborts during a
        // backoff window, surface it immediately instead of waiting out the
        // schedule. AbortError propagates up through runPipeline.
        await abortableSleep(delay, ctx.signal);
      }
    },
  };
}
