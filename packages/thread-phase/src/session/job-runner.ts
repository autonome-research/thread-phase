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
import * as os from 'node:os';
import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';
import { runPipeline, type PipelineSummary } from '../orchestrator.js';
import type { JobOwnership, JobStore } from './job-store.js';
import { signalReasonToString } from '../internal/error-message.js';

export interface LiveEvent {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: string;
}

/**
 * Constructor options for {@link JobRunner}.
 */
export interface JobRunnerOptions {
  /**
   * When set, JobRunner calls `store.heartbeat(jobId)` on a `setInterval`
   * for the duration of each `run()`. Combined with `staleAfterMs` on
   * `JobStore.getJob` / `listJobs`, this lets operators detect runs whose
   * owning process disappeared mid-execution.
   *
   * The timer is cleared on every exit path (success, error, abort) so it
   * cannot outlive its run. A phase that holds the event loop for longer
   * than `heartbeatMs` (e.g. a synchronous CPU spike) will miss its tick
   * window — phases with long inner loops should call `ctx.heartbeat?.()`
   * manually between iterations as well.
   *
   * Recommended range: 5_000 – 30_000. Below 1 second the timer overhead
   * dominates; above a minute the staleness signal lags.
   */
  heartbeatMs?: number;
}

/**
 * Per-run options passed to {@link JobRunner.run}.
 */
export interface JobRunOptions {
  /** Caller-supplied logical session id recorded on the JobRecord. */
  sessionId?: string;
  /**
   * Additional ownership metadata. Defaults are populated automatically
   * from the Node runtime (`process.pid`, `process.ppid`, `process.cwd()`,
   * `os.hostname()`); pass overrides here to suppress or customize.
   */
  ownership?: JobOwnership;
}

export class JobRunner extends EventEmitter {
  private inflight = new Map<string, AbortController>();
  private readonly heartbeatMs?: number;

  constructor(private readonly store: JobStore, options: JobRunnerOptions = {}) {
    super();
    this.setMaxListeners(100);
    this.heartbeatMs = options.heartbeatMs;
  }

  /**
   * Update `heartbeatAt` for an in-flight job. Called automatically by the
   * background timer when `heartbeatMs` is configured; also exposed on
   * `ctx.heartbeat?.()` for phases with long inner loops to call manually.
   */
  heartbeat(jobId: string): Promise<void> {
    return this.store.heartbeat(jobId);
  }

  /**
   * Create a job row, return its id. Use `start()` to actually run it.
   */
  create(name: string, input: unknown): Promise<string> {
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
   *
   * Returns a `PipelineSummary` on success; rejects with the original error
   * on phase failure (after the runner has marked the job FAILED, written a
   * synthesized `error` event to the store, and emitted it to subscribers).
   * Cancellation via `runner.cancel(jobId, reason)` rejects with an
   * `AbortError`-shaped Error (`name === 'AbortError'`); the same FAILED
   * persistence path runs first.
   */
  async run<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(
    jobId: string,
    phases: ReadonlyArray<Phase<TCtx, TEvent>>,
    ctx: TCtx,
    finalResult?: () => unknown,
    options: JobRunOptions = {},
  ): Promise<PipelineSummary> {
    const controller = new AbortController();
    this.inflight.set(jobId, controller);

    // Auto-populate ownership from the Node runtime, allowing per-call
    // overrides. Falls back to undefined fields on platforms that don't
    // expose process.* (the store layer accepts optional fields).
    const ownership: JobOwnership = {
      sessionId: options.sessionId ?? options.ownership?.sessionId,
      pid: options.ownership?.pid ?? safeReadPid(),
      ppid: options.ownership?.ppid ?? safeReadPpid(),
      cwd: options.ownership?.cwd ?? safeReadCwd(),
      hostname: options.ownership?.hostname ?? safeReadHostname(),
    };
    await this.store.setRunning(jobId, ownership);

    // Expose ctx.heartbeat so phase bodies with long inner loops can
    // refresh liveness between iterations. Same effect as the background
    // timer below but driven by the phase itself.
    (ctx as BasePipelineContext).heartbeat = () => this.store.heartbeat(jobId);

    // Background heartbeat timer — runs only when configured AND the
    // store accepts heartbeat calls (no-op stubs in tests fall through).
    // unref() prevents the timer from keeping the event loop alive past
    // the run; the finally clause clears it on every exit path.
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (this.heartbeatMs !== undefined && this.heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        // Swallow heartbeat errors — they should never fail the run.
        void this.store.heartbeat(jobId).catch(() => {
          /* heartbeat is best-effort */
        });
      }, this.heartbeatMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    }

    let eventCount = 0;
    let stopReason: string | undefined;

    const persistError = async (message: string): Promise<void> => {
      await this.store.setFailed(jobId, message);
      const errEvent: PipelineEvent = { type: 'error', message };
      const eventId = await this.store.appendEvent(jobId, errEvent);
      this.emit(`job:${jobId}`, {
        id: eventId,
        jobId,
        eventType: 'error',
        data: errEvent,
        createdAt: new Date().toISOString(),
      } satisfies LiveEvent);
    };

    try {
      for await (const event of runPipeline<TCtx, TEvent>(phases, ctx)) {
        const eventId = await this.store.appendEvent(jobId, event as PipelineEvent);
        this.emit(`job:${jobId}`, {
          id: eventId,
          jobId,
          eventType: event.type,
          data: event,
          createdAt: new Date().toISOString(),
        } satisfies LiveEvent);
        eventCount++;

        if ((event as PipelineEvent).type === 'done') {
          stopReason = (event as { reason?: string }).reason;
        }

        if (controller.signal.aborted) {
          const reason = signalReasonToString(controller.signal, 'cancelled');
          await persistError(`cancelled: ${reason}`);
          const err = new Error(`cancelled: ${reason}`);
          err.name = 'AbortError';
          throw err;
        }
      }
      await this.store.setCompleted(jobId, finalResult ? finalResult() : null);
      return stopReason !== undefined
        ? { status: 'stopped', reason: stopReason, eventCount }
        : { status: 'completed', eventCount };
    } catch (err: unknown) {
      // Re-throw cancellation rejections (already persisted above).
      if (err instanceof Error && err.name === 'AbortError') throw err;
      // Phase exception: persist + rethrow.
      const message = err instanceof Error ? err.message : String(err);
      await persistError(message);
      throw err;
    } finally {
      this.inflight.delete(jobId);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    }
  }
}

// Safe-read helpers — return undefined on platforms or sandboxes that
// don't expose process.* or os.hostname() rather than throwing during
// JobRunner.run() setup.

function safeReadPid(): number | undefined {
  try {
    return typeof process !== 'undefined' ? process.pid : undefined;
  } catch {
    return undefined;
  }
}

function safeReadPpid(): number | undefined {
  try {
    return typeof process !== 'undefined' ? process.ppid : undefined;
  } catch {
    return undefined;
  }
}

function safeReadCwd(): string | undefined {
  try {
    return typeof process !== 'undefined' && typeof process.cwd === 'function'
      ? process.cwd()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeReadHostname(): string | undefined {
  try {
    return os.hostname();
  } catch {
    return undefined;
  }
}
