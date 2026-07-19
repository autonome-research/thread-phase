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
import type { BasePipelineContext, Phase } from '../phase.js';
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
export declare function withRetry<TCtx extends BasePipelineContext>(phase: Phase<TCtx>, options?: WithRetryOptions<TCtx>): Phase<TCtx>;
//# sourceMappingURL=with-retry.d.ts.map