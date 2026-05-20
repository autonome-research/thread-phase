/**
 * runTrigger — the canonical Trigger consumer.
 *
 * Reads events from a `Trigger`, calls a user-supplied factory to produce
 * `{ phases, ctx }` per event, and dispatches each pipeline. If a
 * `JobRunner` is supplied, dispatch is persisted (job rows, event log,
 * cancellation); otherwise the pipeline runs inline via `runPipeline`
 * and events are discarded after dispatch.
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
 */

import type { JobRunner, JobStore } from '../session/index.js';
import { runPipeline } from '../orchestrator.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../phase.js';
import type { Trigger, TriggerEvent } from './types.js';

export interface RunTriggerOptions<TInput, TCtx extends BasePipelineContext> {
  /**
   * Optional JobRunner. If provided, each event creates a persisted job
   * row and pipelines run through `runner.run()` (events go to the
   * event log, cancellation works via `runner.cancel(jobId)`). If
   * omitted, pipelines run inline via `runPipeline` — events are
   * iterated but discarded after dispatch.
   */
  jobRunner?: JobRunner;
  /**
   * The `JobStore` the `jobRunner` was constructed with. When provided,
   * `runTrigger` inspects job status after each run and routes failed
   * jobs to `onError`. If omitted, `onComplete` fires regardless of
   * job outcome (caller must inspect status themselves).
   */
  jobStore?: JobStore;
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
  /** Called when a pipeline is about to start. */
  onStart?: (event: TriggerEvent<TInput>, jobId?: string) => void;
  /** Called when a pipeline completes successfully. */
  onComplete?: (event: TriggerEvent<TInput>, jobId?: string) => void;
  /** Called when a pipeline throws. Default: log to stderr. */
  onError?: (event: TriggerEvent<TInput>, error: Error, jobId?: string) => void;
}

export interface RunTriggerHandle {
  /** Resolves when the run loop has exited (trigger exhausted, signal fired, or `stop()` called). */
  done: Promise<void>;
  /** Stop the trigger and resolve `done` once outstanding pipelines complete. */
  stop(): Promise<void>;
}

export function runTrigger<TInput, TCtx extends BasePipelineContext>(
  trigger: Trigger<TInput>,
  pipelineFactory: (input: TInput, event: TriggerEvent<TInput>) => {
    phases: Phase<TCtx>[];
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

  const inflight = new Set<Promise<void>>();
  let aborted = false;

  const dispatch = (event: TriggerEvent<TInput>): Promise<void> => {
    const { phases, ctx } = pipelineFactory(event.input, event);

    const work = (async (): Promise<void> => {
      let jobId: string | undefined;
      let failureMessage: string | undefined;
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
          await options.jobRunner.run(jobId, phases, ctx);
          // JobRunner swallows errors internally; inspect job status when
          // a JobStore is supplied so we can route failures to onError.
          const job = options.jobStore?.getJob(jobId);
          if (job?.status === 'FAILED') {
            failureMessage = job.error ?? 'pipeline failed';
          }
        } else {
          // runPipeline also swallows phase throws as an `error` event;
          // capture the message rather than re-throw.
          for await (const evt of runPipeline(phases, ctx)) {
            if (evt.type === 'error') {
              failureMessage = evt.message;
            }
          }
        }

        if (failureMessage !== undefined) {
          onError(event, new Error(failureMessage), jobId);
        } else {
          options.onComplete?.(event, jobId);
        }
      } catch (err) {
        // Truly unexpected: factory threw, or JobRunner.run rejected for
        // some non-pipeline reason. Surface through the same onError hook.
        const error = err instanceof Error ? err : new Error(String(err));
        onError(event, error, jobId);
      }
    })();

    inflight.add(work);
    work.finally(() => inflight.delete(work));
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

        // Block until a concurrency slot is available — backpressure
        // flows back to the trigger by way of the generator pausing.
        while (inflight.size >= maxConcurrency && !aborted) {
          await Promise.race(Array.from(inflight));
        }
        if (aborted) break;

        void dispatch(event);
      }
    } finally {
      // Wait for any in-flight pipelines to settle before resolving.
      await Promise.allSettled(Array.from(inflight));
    }
  };

  return {
    done: loop(),
    stop,
  };
}
