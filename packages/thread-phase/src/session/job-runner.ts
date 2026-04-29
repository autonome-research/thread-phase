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
   * Run a pipeline as job `jobId`. Persists every event, emits on `job:${id}`.
   * Resolves when the pipeline completes (or fails). Errors are caught and
   * persisted; they do not throw out of this method.
   *
   * The caller controls the pipeline composition by passing phases + ctx.
   */
  async run<TCtx extends BasePipelineContext>(
    jobId: string,
    phases: ReadonlyArray<Phase<TCtx>>,
    ctx: TCtx,
    finalResult?: () => unknown,
  ): Promise<void> {
    this.store.setRunning(jobId);

    try {
      for await (const event of runPipeline(phases, ctx)) {
        const eventId = this.store.appendEvent(jobId, event);
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
    }
  }
}
