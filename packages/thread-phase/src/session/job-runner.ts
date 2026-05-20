/**
 * Job runner — wraps a pipeline run with persistent event logging and live
 * event emission.
 *
 * Three audiences for the same event stream:
 *   - The store (for resumability via JobStore.getEvents).
 *   - Live SSE-style listeners (subscribe via runner.on(`job:${id}`, ...)).
 *   - The caller's own AsyncGenerator consumer if they want to drive directly.
 *
 * Pipeline execution is decoupled from client connection: a job runs to
 * completion regardless of who's listening. Late-attaching consumers replay
 * via JobStore.getEvents.
 *
 * Cancellation: each in-flight job tracks an AbortController. Call
 * `runner.cancel(jobId, reason?)` to abort the in-flight pipeline. The
 * controller's signal is exposed via `runner.signalFor(jobId)` so callers
 * (typically phase code that calls runAgentWithTools) can plumb it into
 * the inference layer. Without that plumbing, cancellation only halts
 * BETWEEN phases.
 */

import { EventEmitter } from 'events';
import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';
import { runPipeline } from '../orchestrator.js';
import type { JobStore } from './job-store.js';

export interface LiveEvent {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: string;
}

export class JobRunner extends EventEmitter {
  private inflight = new Map<string, AbortController>();

  constructor(private readonly store: JobStore) {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Create a job row, return its id. Use `start()` to actually run it.
   */
  create(name: string, input: unknown): string {
    return this.store.createJob(name, input);
  }

  /**
   * AbortSignal for a running job. Phase code should pass this through to
   * `runAgentWithTools({ signal })` so cancellation reaches the inference
   * call instead of just halting between phases.
   *
   * Returns `undefined` if the job isn't currently running on this runner.
   */
  signalFor(jobId: string): AbortSignal | undefined {
    return this.inflight.get(jobId)?.signal;
  }

  /**
   * Request cancellation of an in-flight job. Aborts the controller (which
   * propagates into any inference call wired to `signalFor(jobId)`) and
   * lets the run-loop unwind. The job is marked FAILED with the given
   * reason once unwinding completes. No-op if the job isn't running.
   */
  cancel(jobId: string, reason: string = 'cancelled'): void {
    const controller = this.inflight.get(jobId);
    if (!controller) return;
    if (!controller.signal.aborted) {
      // Node's AbortController accepts an optional reason on abort().
      controller.abort(reason);
    }
  }

  /**
   * Run a pipeline as job `jobId`. Persists every event, emits on `job:${id}`.
   * Resolves when the pipeline completes (or fails). Errors are caught and
   * persisted; they do not throw out of this method.
   *
   * The caller controls the pipeline composition by passing phases + ctx.
   *
   * Generic over `TEvent` so downstream apps that parameterize Phase with a
   * custom event type get the same type through the run loop. TEvent must
   * include the framework's `error` shape (it's used to narrow on failure)
   * — typically downstream defines `type MyEvent = PipelineEvent | { ... }`.
   */
  async run<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(
    jobId: string,
    phases: ReadonlyArray<Phase<TCtx, TEvent>>,
    ctx: TCtx,
    finalResult?: () => unknown,
  ): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(jobId, controller);

    this.store.setRunning(jobId);

    try {
      for await (const event of runPipeline<TCtx, TEvent>(phases, ctx)) {
        const eventId = this.store.appendEvent(jobId, event as PipelineEvent);
        this.emit(`job:${jobId}`, {
          id: eventId,
          jobId,
          eventType: event.type,
          data: event,
          createdAt: new Date().toISOString(),
        } satisfies LiveEvent);

        if (event.type === 'error') {
          this.store.setFailed(jobId, event.message);
          return;
        }

        if (controller.signal.aborted) {
          const reason =
            (controller.signal.reason as string | undefined) ?? 'cancelled';
          this.store.setFailed(jobId, `cancelled: ${reason}`);
          const cancelEvent: PipelineEvent = {
            type: 'error',
            message: `cancelled: ${reason}`,
          };
          const cancelEventId = this.store.appendEvent(jobId, cancelEvent);
          this.emit(`job:${jobId}`, {
            id: cancelEventId,
            jobId,
            eventType: 'error',
            data: cancelEvent,
            createdAt: new Date().toISOString(),
          } satisfies LiveEvent);
          return;
        }
      }
      this.store.setCompleted(jobId, finalResult ? finalResult() : null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.setFailed(jobId, message);
      const errEvent: PipelineEvent = { type: 'error', message };
      const eventId = this.store.appendEvent(jobId, errEvent);
      this.emit(`job:${jobId}`, {
        id: eventId,
        jobId,
        eventType: 'error',
        data: errEvent,
        createdAt: new Date().toISOString(),
      } satisfies LiveEvent);
    } finally {
      this.inflight.delete(jobId);
    }
  }
}
