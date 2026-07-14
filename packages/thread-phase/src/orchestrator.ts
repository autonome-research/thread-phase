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
import { signalReasonToString } from './internal/error-message.js';

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
  /**
   * Resume-from-checkpoint option. When provided, phases whose
   * `checkpointKey` appears in `completedKeys` are SKIPPED — their
   * `run(ctx)` is not invoked, no `phase_complete` event is re-emitted.
   * Phases without a `checkpointKey` always run.
   *
   * Derive `completedKeys` from a prior run's event log via
   * `completedCheckpointsFromEvents`.
   *
   * Resume restores ORCHESTRATOR POSITION ONLY. It does not restore the
   * cache, `ctx.stop`, thread state, memory, or any caller-defined ctx
   * fields. The caller is responsible for rebuilding ctx into a state
   * the skipped phases would have left it in.
   */
  resume?: {
    completedKeys: ReadonlySet<string>;
  };
}

/**
 * Derive the set of completed `checkpointKey` values from an iterable
 * of `PipelineEvent`s. Use to translate a prior run's event log into
 * `RunPipelineOptions.resume.completedKeys`.
 *
 *   const events = await store.getEvents(prevJobId);
 *   const completedKeys = completedCheckpointsFromEvents(events.map(e => e.data));
 *   await runPipeline(phases, freshCtx, { resume: { completedKeys } });
 */
export function completedCheckpointsFromEvents(
  events: Iterable<PipelineEvent>,
): Set<string> {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type === 'phase_complete') {
      keys.add(e.checkpointKey);
    }
  }
  return keys;
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
  const completedKeys = options?.resume?.completedKeys;
  try {
    for (const phase of phases) {
      if (signal?.aborted) {
        // signalReasonToString centralizes the abort-reason coercion so
        // every call site (orchestrator, JobRunner, future consumers)
        // agrees on the contract: undefined → fallback, otherwise pass
        // through toErrorMessage so Error and arbitrary-object reasons
        // surface their message instead of getting silently swallowed.
        const reason = signalReasonToString(signal);
        // Emit a canonical terminal frame BEFORE throwing so for-await
        // consumers (SSE bridges, audit logs) can record the lifecycle
        // cleanly. Promise-style consumers still observe AbortError via
        // the throw on the next iteration.
        yield { type: 'cancelled', reason };
        const err = new Error(`runPipeline aborted: ${reason}`);
        err.name = 'AbortError';
        throw err;
      }
      // Skip-on-resume: a phase is skipped iff it has a checkpointKey AND
      // that key already appears in completedKeys (from a prior run's
      // event log). No phase_complete is re-emitted; the existing event
      // in the prior log is the durable record.
      if (
        phase.checkpointKey !== undefined &&
        completedKeys?.has(phase.checkpointKey)
      ) {
        continue;
      }
      yield* phase.run(ctx);
      // A cooperative phase may observe the signal and return cleanly. Check
      // again before recording its checkpoint or emitting done so callers can
      // never mistake a cancelled run for successful completion.
      if (signal?.aborted) {
        const reason = signalReasonToString(signal);
        yield { type: 'cancelled', reason } as TEvent;
        const err = new Error(`runPipeline aborted: ${reason}`);
        err.name = 'AbortError';
        throw err;
      }
      // Emit phase_complete AFTER the phase's generator has exhausted
      // cleanly (no throw — yield* would have re-thrown). Only emitted
      // for phases that opted in via checkpointKey, so the event log
      // stays compact.
      if (phase.checkpointKey !== undefined) {
        yield {
          type: 'phase_complete',
          phase: phase.name,
          checkpointKey: phase.checkpointKey,
        };
      }
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
