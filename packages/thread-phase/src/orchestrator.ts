/**
 * Pipeline orchestrator — runs a list of phases over a shared context.
 *
 * Owns the canonical terminal events (`done` / `error`) so phases never have
 * to emit them themselves. Halts the pipeline cleanly when any phase sets
 * `ctx.stop`.
 *
 * Composition is just an array of phases. Reorder by reordering the array.
 * Add a phase by including a new entry. No DAG framework, no plugin system.
 *
 * Generic over the phases' event type. Downstream apps that parameterize
 * Phase with a custom TEvent get the same TEvent surfaced through the
 * orchestrator's stream — but TEvent must be assignable from the
 * framework's `done`/`error` shapes (see PipelineEvent), so the simplest
 * downstream pattern is `type MyEvent = PipelineEvent | { type: 'mine' };`.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from './phase.js';
import { toErrorMessage } from './internal/error-message.js';

/**
 * The terminal state of a pipeline run.
 *
 * - `completed` — all phases ran to completion.
 * - `stopped` — a phase set `ctx.stop`; pipeline halted cleanly with that reason.
 *
 * Phase exceptions do not produce a summary; they propagate to the caller.
 * Use `runPipelineToSummary` to wrap the generator and convert throws into
 * promise rejections (with the original error preserved).
 */
export interface PipelineSummary {
  readonly status: 'completed' | 'stopped';
  /** Present iff `status === 'stopped'`. The `ctx.stop.reason` value. */
  readonly reason?: string;
  /** Total events yielded, including the terminal `done` event. */
  readonly eventCount: number;
}

export interface RunPipelineOptions {
  /**
   * AbortSignal observed between phases. If the signal aborts at any point,
   * `runPipeline` throws an `AbortError` (`name === 'AbortError'`) before
   * the next phase runs. Phases that want mid-phase cancellation should
   * observe the signal themselves and unwind cleanly.
   */
  signal?: AbortSignal;
}

export async function* runPipeline<
  TCtx extends BasePipelineContext,
  TEvent = PipelineEvent,
>(
  phases: ReadonlyArray<Phase<TCtx, TEvent>>,
  ctx: TCtx,
  options?: RunPipelineOptions,
  // Output type is `TEvent | PipelineEvent`: phases yield TEvent, the
  // orchestrator additionally yields canonical `done` (PipelineEvent).
  // The wider type also catches the foot-gun where a caller parameterized
  // TEvent as something narrow that does NOT include PipelineEvent —
  // previously they received `{type:'done'}` via an `as unknown as TEvent`
  // cast; now the type system tells them they may also see PipelineEvent.
): AsyncGenerator<TEvent | PipelineEvent, void> {
  // Signal resolution: options.signal wins if provided; otherwise honor a
  // pre-set ctx.signal (callers that already populated ctx — including
  // run-trigger and tests building ctx by hand). Whichever wins is assigned
  // back to ctx so phases observing ctx.signal see the same value the
  // orchestrator uses for its between-phase abort check.
  const signal = options?.signal ?? ctx.signal;
  ctx.signal = signal;
  try {
    for (const phase of phases) {
      if (signal?.aborted) {
        // AbortSignal.reason is `any` per spec — most callers pass strings,
        // many pass Error instances, and SDKs occasionally pass arbitrary
        // objects. toErrorMessage extracts a string from any of these
        // without destroying diagnostic information (vs. the prior
        // `as string` cast that silently coerced non-strings to 'aborted').
        const reason = signal.reason === undefined
          ? 'aborted'
          : toErrorMessage(signal.reason);
        // Emit a canonical terminal frame BEFORE throwing so for-await
        // consumers (SSE bridges, audit logs) can record the lifecycle
        // cleanly. Promise-style consumers still observe AbortError via
        // the throw on the next iteration.
        yield { type: 'cancelled', reason };
        const err = new Error(`runPipeline aborted: ${reason}`);
        err.name = 'AbortError';
        throw err;
      }
      yield* phase.run(ctx);
      if (ctx.stop) {
        yield { type: 'done', reason: ctx.stop.reason };
        return;
      }
    }
    yield { type: 'done' };
  } finally {
    ctx.cache.clear();
  }
}

/**
 * Consume `runPipeline` to completion and return a typed summary.
 *
 * On success, resolves with `{ status, reason?, eventCount }`. Phase
 * exceptions reject the promise with the original error (the cache is
 * still cleared via the generator's `finally`).
 *
 * Use this when you want a single `await` for the whole pipeline rather
 * than iterating events yourself.
 */
export async function runPipelineToSummary<
  TCtx extends BasePipelineContext,
  TEvent extends PipelineEvent = PipelineEvent,
>(
  phases: ReadonlyArray<Phase<TCtx, TEvent>>,
  ctx: TCtx,
  options?: RunPipelineOptions,
): Promise<PipelineSummary> {
  let eventCount = 0;
  let stopReason: string | undefined;
  for await (const event of runPipeline<TCtx, TEvent>(phases, ctx, options)) {
    eventCount++;
    if ((event as PipelineEvent).type === 'done') {
      stopReason = (event as { reason?: string }).reason;
    }
  }
  return stopReason !== undefined
    ? { status: 'stopped', reason: stopReason, eventCount }
    : { status: 'completed', eventCount };
}
