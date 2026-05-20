/**
 * runTrigger — the canonical Trigger consumer.
 *
 * Reads events from a `Trigger`, calls a user-supplied factory to produce
 * `{ phases, ctx }` per event, and dispatches each pipeline. If a
 * `JobRunner` is supplied, dispatch is persisted (job rows, event log,
 * cancellation); otherwise the pipeline runs inline via
 * `runPipelineToSummary` and events are discarded after dispatch.
 *
 * Resolves when the trigger generator exhausts, the abort signal fires,
 * or `stop()` is called via the returned handle.
 *
 * Concurrency cap is a blocking semaphore. When `maxConcurrency` pipelines
 * are in flight, the loop awaits a slot before pulling the next event
 * from the trigger. The trigger's generator naturally pauses production
 * — no events are dropped, no unbounded queue grows.
 *
 * Pipeline failures are isolated — one failing pipeline does not stop
 * the trigger loop. Errors go through `onError` (or default stderr log)
 * and the next event is still dispatched.
 *
 * Cancellation: each in-flight dispatch owns an `AbortController`. Call
 * `handle.cancel(triggerEventId)` to abort that specific pipeline; the
 * signal flows into `runPipelineToSummary` (inline) or `jobRunner.cancel`
 * (persisted). Returns `true` if the pipeline was found and aborted,
 * `false` if the event id is unknown or already completed.
 *
 * Observability: `onCapacityFull(event)` fires when an event arrives
 * while the concurrency cap is full (the loop blocks on `Promise.race`
 * before pulling the event, so this is the moment backpressure starts).
 * `onDispatchStart(event)` fires immediately when a dispatch begins,
 * before the user-supplied factory runs.
 */

import type { JobRunner } from '../session/index.js';
import { runPipelineToSummary } from '../orchestrator.js';
import type {
  BasePipelineContext,
  Phase,
} from '../phase.js';
import type { Trigger, TriggerEvent } from './types.js';

export interface RunTriggerOptions<TInput, TCtx extends BasePipelineContext> {
  /**
   * Optional JobRunner. If provided, each event creates a persisted job
   * row and pipelines run through `runner.run()` (events go to the
   * event log, cancellation works via `runner.cancel(jobId)`). If
   * omitted, pipelines run inline.
   */
  jobRunner?: JobRunner;
  /** Name used for job rows when `jobRunner` is set. Default: `trigger.name`. */
  pipelineName?: string;
  /**
   * Maximum concurrent in-flight pipelines from this trigger. When the
   * cap is reached, the loop blocks before pulling the next event
   * (backpressure flows back to the trigger). Default: 1.
   */
  maxConcurrency?: number;
  /** Abort the run loop and call `trigger.stop()`. Outstanding pipelines complete. */
  signal?: AbortSignal;
  /** Called when a pipeline is about to start, after dispatch picks it up. */
  onStart?: (event: TriggerEvent<TInput>, jobId?: string) => void;
  /** Called when a pipeline completes successfully. */
  onComplete?: (event: TriggerEvent<TInput>, jobId?: string) => void;
  /** Called when a pipeline throws. Default: log to stderr. */
  onError?: (event: TriggerEvent<TInput>, error: Error, jobId?: string) => void;
  /**
   * Called when an event arrives while the concurrency cap is full —
   * the moment backpressure begins. The dispatch still happens once a
   * slot frees; this hook only signals the wait.
   */
  onCapacityFull?: (event: TriggerEvent<TInput>) => void;
  /** Called the moment dispatch starts, before the pipeline factory runs. */
  onDispatchStart?: (event: TriggerEvent<TInput>) => void;
}

export interface RunTriggerHandle {
  /** Resolves when the run loop has exited (trigger exhausted, signal fired, or `stop()` called). */
  done: Promise<void>;
  /** Stop the trigger and resolve `done` once outstanding pipelines complete. */
  stop(): Promise<void>;
  /**
   * Abort a specific in-flight pipeline by its trigger event id. Returns
   * `true` if the pipeline was found and cancellation was initiated;
   * `false` if the event id is unknown or already completed.
   */
  cancel(triggerEventId: number): boolean;
}

interface Dispatch {
  controller: AbortController;
  jobId?: string;
  promise: Promise<void>;
}

export function runTrigger<TInput, TCtx extends BasePipelineContext>(
  trigger: Trigger<TInput>,
  pipelineFactory: (input: TInput, event: TriggerEvent<TInput>) => {
    phases: ReadonlyArray<Phase<TCtx>>;
    ctx: TCtx;
  },
  options: RunTriggerOptions<TInput, TCtx> = {},
): RunTriggerHandle {
  const maxConcurrency = options.maxConcurrency ?? 1;
  const pipelineName = options.pipelineName ?? trigger.name;

  const onError =
    options.onError ??
    ((event, err) => {
      console.error(
        `[trigger:${trigger.name}] event ${event.id} failed:`,
        err.message,
      );
    });

  const inflight = new Map<number, Dispatch>();
  let aborted = false;

  const dispatch = (event: TriggerEvent<TInput>): Promise<void> => {
    options.onDispatchStart?.(event);

    const controller = new AbortController();
    const { phases, ctx } = pipelineFactory(event.input, event);
    // Wire the per-dispatch signal into ctx so phases can observe it for
    // mid-phase cancellation (in addition to runPipeline's between-phase
    // check via the same signal forwarded below).
    ctx.signal = controller.signal;

    let jobId: string | undefined;

    const work = (async (): Promise<void> => {
      try {
        if (options.jobRunner) {
          jobId = options.jobRunner.create(pipelineName, {
            triggerName: trigger.name,
            triggerEventId: event.id,
            occurredAt: event.occurredAt,
            input: event.input,
            metadata: event.metadata,
          });
        }
        options.onStart?.(event, jobId);

        if (options.jobRunner && jobId) {
          // JobRunner has its own controller per job (signalFor / cancel).
          // The dispatch's AbortController is wired so handle.cancel(eventId)
          // delegates to jobRunner.cancel(jobId).
          const jobIdAtRun = jobId;
          controller.signal.addEventListener('abort', () => {
            options.jobRunner!.cancel(
              jobIdAtRun,
              (controller.signal.reason as string | undefined) ?? 'cancelled',
            );
          }, { once: true });
          await options.jobRunner.run(jobId, phases, ctx);
        } else {
          // Inline path: forward the signal to runPipelineToSummary so
          // phase code that observes it (or the orchestrator's pre-phase
          // check) can unwind cleanly.
          await runPipelineToSummary(phases, ctx, { signal: controller.signal });
        }
        options.onComplete?.(event, jobId);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onError(event, error, jobId);
      }
    })();

    inflight.set(event.id, { controller, promise: work, jobId });
    work.finally(() => inflight.delete(event.id));
    return work;
  };

  const stop = async (): Promise<void> => {
    if (aborted) return;
    aborted = true;
    await trigger.stop();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      void stop();
    } else {
      options.signal.addEventListener('abort', () => void stop(), { once: true });
    }
  }

  const loop = async (): Promise<void> => {
    const gen = trigger.start();
    try {
      for await (const event of gen) {
        if (aborted) break;

        // Block until a concurrency slot is available — backpressure flows
        // back to the trigger by way of the generator pausing. If we have
        // to wait, fire onCapacityFull so the user knows.
        if (inflight.size >= maxConcurrency) {
          options.onCapacityFull?.(event);
        }
        while (inflight.size >= maxConcurrency && !aborted) {
          await Promise.race(
            Array.from(inflight.values()).map((d) => d.promise),
          );
        }
        if (aborted) break;

        void dispatch(event);
      }
    } finally {
      // Wait for any in-flight pipelines to settle before resolving.
      await Promise.allSettled(
        Array.from(inflight.values()).map((d) => d.promise),
      );
    }
  };

  const cancel = (triggerEventId: number): boolean => {
    const dispatchRec = inflight.get(triggerEventId);
    if (!dispatchRec) return false;
    if (dispatchRec.controller.signal.aborted) return false;
    dispatchRec.controller.abort('cancelled by handle');
    return true;
  };

  return {
    done: loop(),
    stop,
    cancel,
  };
}
