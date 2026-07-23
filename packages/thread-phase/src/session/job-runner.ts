/**
 * Job runner — persistent execution, live events, cancellation, and liveness.
 *
 * JobRunner owns the authoritative lifecycle for one in-process pipeline run.
 * It composes its cancellation signal with any caller-provided ctx.signal,
 * persists cancellation separately from failure, and guarantees that terminal
 * store transitions cannot overwrite one another.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'events';
import * as os from 'node:os';
import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';
import { runPipeline, type PipelineSummary } from '../orchestrator.js';
import { JobOwnershipLostError, type JobOwnership, type JobStore } from './job-store.js';
import { signalReasonToString } from '../internal/error-message.js';

export interface LiveEvent {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: string;
}

export interface LiveEventListenerFailure {
  /** The immutable live event whose observer failed. */
  readonly event: LiveEvent;
  /** The observer's thrown or rejected value, normalized to an Error. */
  readonly error: Error;
}

export interface JobRunnerOptions {
  /** Automatic heartbeat interval for active runs. */
  heartbeatMs?: number;
  /**
   * Maximum duration of one heartbeat attempt. Requires heartbeatMs and
   * defaults to heartbeatMs. Once configured, it applies to automatic attempts
   * and manual ctx.heartbeat() refreshes. Manual-only runs cannot currently
   * configure a timeout. This bounds runner waiting; it cannot cancel a custom
   * store's underlying I/O.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Observe isolated failures from `job:${jobId}` live-event listeners.
   * Observer failures are contained and never affect authoritative lifecycle.
   */
  onLiveEventError?: (failure: LiveEventListenerFailure) => void | Promise<void>;
}

export type JobRunDrain = () => void | PromiseLike<void>;

export interface JobRunOptions {
  /** Caller-supplied logical session id recorded on the JobRecord. */
  sessionId?: string;
  /** Additional or overridden ownership metadata. */
  ownership?: JobOwnership;
  /** Host-defined source such as `pi-tool`, `cron`, or `webhook`. */
  launchSource?: string;
  /**
   * Asynchronous resources to drain, in registration order, before any
   * terminal job transition and before the runner releases its local hooks.
   * Drains also run when ownership acquisition loses or rejects.
   *
   * All drains are attempted even when one fails. On an otherwise successful
   * run, drain failure makes the job FAILED. A pipeline failure or cancellation
   * remains authoritative; accompanying drain failures are exposed on the
   * rejected AggregateError without replacing the persisted terminal reason.
   */
  drains?: ReadonlyArray<JobRunDrain>;
}

/** Immediate handle returned by {@link JobRunner.start}. */
export interface JobRunHandle {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly result: Promise<PipelineSummary>;
  cancel(reason?: string): void;
}

interface InflightRun {
  controller: AbortController;
  signal: AbortSignal;
  claim: Promise<boolean>;
  cancellationRequested?: Promise<void>;
  cancelReason?: string;
  terminationCause?: 'cancellation' | 'heartbeat' | 'pipeline' | 'completion';
}

export class JobRunner extends EventEmitter {
  private inflight = new Map<string, InflightRun>();
  private activeContexts = new WeakSet<object>();
  private readonly heartbeatMs?: number;
  private readonly heartbeatTimeoutMs?: number;
  private readonly onLiveEventError?: JobRunnerOptions['onLiveEventError'];

  constructor(private readonly store: JobStore, options: JobRunnerOptions = {}) {
    super();
    this.setMaxListeners(100);
    if (
      options.heartbeatMs !== undefined &&
      (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs < 1)
    ) {
      throw new RangeError('heartbeatMs must be a positive safe integer');
    }
    if (
      options.heartbeatTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.heartbeatTimeoutMs) || options.heartbeatTimeoutMs < 1)
    ) {
      throw new RangeError('heartbeatTimeoutMs must be a positive safe integer');
    }
    if (options.heartbeatTimeoutMs !== undefined && options.heartbeatMs === undefined) {
      throw new RangeError('heartbeatTimeoutMs requires heartbeatMs');
    }
    this.heartbeatMs = options.heartbeatMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? options.heartbeatMs;
    this.onLiveEventError = options.onLiveEventError;
  }

  /** Explicit unscoped heartbeat for operator-driven recovery workflows. */
  heartbeatAsOperator(jobId: string): Promise<void> {
    return this.store.heartbeat(jobId);
  }

  /** @deprecated Use {@link heartbeatAsOperator} to make the ownership bypass explicit. */
  heartbeat(jobId: string): Promise<void> {
    return this.heartbeatAsOperator(jobId);
  }

  create(name: string, input: unknown): Promise<string> {
    return this.store.createJob(name, input);
  }

  signalFor(jobId: string): AbortSignal | undefined {
    return this.inflight.get(jobId)?.signal;
  }

  /**
   * Start a run and return its cancellation signal/result immediately.
   * The job row must already exist; call {@link create} first. If synchronous
   * option/context inspection rejects setup, the handle contains an already
   * aborted signal and `result` retains that original rejection.
   */
  start<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(
    jobId: string,
    phases: ReadonlyArray<Phase<TCtx, TEvent>>,
    ctx: TCtx,
    finalResult?: () => unknown,
    options: JobRunOptions = {},
  ): JobRunHandle {
    this.assertLocalAvailability(jobId, ctx);
    const result = this.run(jobId, phases, ctx, finalResult, options);
    // run() performs setup synchronously until its first await. A rejected
    // setup is represented by its result promise, so preserve that promise
    // instead of replacing the original error with an initialization throw.
    const signal = this.signalFor(jobId)
      ?? AbortSignal.abort(new Error(`JobRunner failed to initialize run ${jobId}`));
    return {
      jobId,
      signal,
      result,
      cancel: (reason = 'cancelled') => this.cancel(jobId, reason),
    };
  }

  /**
   * Request cancellation. The request is persisted before terminal
   * cancellation is finalized. Returns false when no local run owns jobId.
   */
  cancel(jobId: string, reason: string = 'cancelled'): boolean {
    const entry = this.inflight.get(jobId);
    if (!entry || (entry.terminationCause !== undefined && entry.terminationCause !== 'cancellation')) {
      return false;
    }
    if (!entry.cancellationRequested) {
      if (!entry.terminationCause) entry.terminationCause = 'cancellation';
      entry.cancelReason = reason;
      const request = entry.claim.then(async (claimed) => {
        if (!claimed) return;
        await this.appendLive(jobId, { type: 'cancellation_requested', reason });
      });
      entry.cancellationRequested = request;
      // Cancellation can be requested well before run() reaches its catch path.
      // Observe the rejection now to prevent an unhandled-rejection report, but
      // retain the original promise so lifecycle completion still surfaces it.
      void request.catch(() => undefined);
    }
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    return true;
  }

  /**
   * Convert read-time stale jobs into durable ABANDONED terminal records.
   * A separate operator/host decides how often reconciliation runs.
   */
  async reconcileAbandoned(staleAfterMs: number, reason = 'owner heartbeat expired'): Promise<string[]> {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new RangeError('staleAfterMs must be a finite positive number');
    }
    const staleBefore = new Date(Date.now() - staleAfterMs);
    const reconciled: string[] = [];
    let previousRejectedPage: string | undefined;
    while (true) {
      // Keep listing and guarded finalization on the same invocation-time
      // cutoff. Expressing that fixed cutoff through the duration-based store
      // API requires increasing staleAfterMs as the scan itself ages.
      const listingStaleAfterMs = Math.max(1, Date.now() - staleBefore.getTime());
      const stale = await this.store.listJobs({
        status: 'STALE',
        staleAfterMs: listingStaleAfterMs,
        limit: 100,
      });
      if (stale.length === 0) break;
      const pageIdentity = stale
        .map((job) => `${job.id}\u0000${job.ownerId ?? ''}`)
        .sort()
        .join('\u0001');
      let transitioned = 0;
      for (const job of stale) {
        const terminal = await this.store.finalizeAbandonedIfStale(
          job.id,
          staleBefore,
          reason,
          job.ownerId,
        );
        if (!terminal) continue;
        transitioned++;
        this.emitRecord(terminal);
        reconciled.push(job.id);
      }
      if (transitioned === 0) {
        // A listed page may recover before its guarded transition. Re-query so
        // those rows can disappear and expose later stale pages, but stop when
        // a backend returns the same wholly rejected page twice.
        if (previousRejectedPage === pageIdentity) break;
        previousRejectedPage = pageIdentity;
        continue;
      }
      previousRejectedPage = undefined;
      if (stale.length < 100) break;
    }
    return reconciled;
  }

  async run<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(
    jobId: string,
    phases: ReadonlyArray<Phase<TCtx, TEvent>>,
    ctx: TCtx,
    finalResult?: () => unknown,
    options: JobRunOptions = {},
  ): Promise<PipelineSummary> {
    this.assertLocalAvailability(jobId, ctx);

    const controller = new AbortController();
    const previousSignal = ctx.signal;
    const signal = previousSignal
      ? AbortSignal.any([previousSignal, controller.signal])
      : controller.signal;
    const previousHeartbeat = ctx.heartbeat;
    const ownership: JobOwnership = {
      sessionId: options.sessionId ?? options.ownership?.sessionId,
      pid: options.ownership?.pid ?? safeReadPid(),
      ppid: options.ownership?.ppid ?? safeReadPpid(),
      cwd: options.ownership?.cwd ?? safeReadCwd(),
      hostname: options.ownership?.hostname ?? safeReadHostname(),
      ownerId: options.ownership?.ownerId ?? randomUUID(),
      launchSource: options.launchSource ?? options.ownership?.launchSource,
      heartbeatEnabled: options.ownership?.heartbeatEnabled ?? (this.heartbeatMs !== undefined && this.heartbeatMs > 0),
    };
    const ownerId = ownership.ownerId!;
    const registeredDrains = [...(options.drains ?? [])];
    // Keep one stable claim promise so a reentrant cancel from a context setter
    // can wait for ownership, but do not invoke the store until every context
    // hook has installed successfully. Structural stores may throw before
    // returning a Promise, so the actual call remains deferred to a microtask.
    let resolveClaim!: (claimed: boolean) => void;
    let rejectClaim!: (error: unknown) => void;
    const claim = new Promise<boolean>((resolve, reject) => {
      resolveClaim = resolve;
      rejectClaim = reject;
    });
    const entry: InflightRun = {
      controller,
      signal,
      claim,
    };
    const markCallerCancellation = (): void => {
      if (!entry.terminationCause) entry.terminationCause = 'cancellation';
    };
    let callerCancellationListenerAttached = false;
    let activeContextRegistered = false;
    let inflightRegistered = false;
    try {
      if (previousSignal?.aborted) markCallerCancellation();
      else if (previousSignal) {
        previousSignal.addEventListener('abort', markCallerCancellation, { once: true });
        callerCancellationListenerAttached = true;
      }
      this.activeContexts.add(ctx);
      activeContextRegistered = true;
      this.inflight.set(jobId, entry);
      inflightRegistered = true;
      ctx.signal = signal;
    } catch (error: unknown) {
      // No store call has been created yet. Settle any reentrant cancellation
      // waiter without claiming the persisted job.
      resolveClaim(false);
      if (inflightRegistered) this.inflight.delete(jobId);
      if (activeContextRegistered) this.activeContexts.delete(ctx);
      if (callerCancellationListenerAttached) {
        try { previousSignal?.removeEventListener('abort', markCallerCancellation); }
        catch { /* Preserve the original setup failure. */ }
      }
      try { ctx.signal = previousSignal; }
      catch { /* Preserve the original setup failure. */ }
      throw error;
    }

    void Promise.resolve()
      .then(() => this.store.setRunning(jobId, ownership))
      .then(resolveClaim, rejectClaim);

    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInFlight: Promise<void> | null = null;
    let heartbeatStopped = false;
    let heartbeatFailure: unknown;
    let heartbeatOptedIn = ownership.heartbeatEnabled === true;
    let eventCount = 0;
    let stopReason: string | undefined;
    let ownershipAcquired = false;
    let drainResult: Promise<unknown[]> | undefined;

    const drainResources = (): Promise<unknown[]> => {
      if (!drainResult) {
        drainResult = (async () => {
          const failures: unknown[] = [];
          for (const drain of registeredDrains) {
            try {
              await drain();
            } catch (error: unknown) {
              failures.push(error);
            }
          }
          return failures;
        })();
      }
      return drainResult;
    };

    const recordHeartbeatFailure = (error: unknown): void => {
      const failure = error instanceof Error ? error : new Error(String(error));
      heartbeatStopped = true;
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (entry.terminationCause && entry.terminationCause !== 'heartbeat') return;
      entry.terminationCause = 'heartbeat';
      if (heartbeatFailure === undefined) heartbeatFailure = failure;
      if (!controller.signal.aborted) controller.abort(failure);
    };

    const refreshOwnedHeartbeat = async (): Promise<void> => {
      if (!heartbeatOptedIn) {
        // Published v5 stores may return false when heartbeat was already
        // enabled rather than only on ownership loss, so this result cannot be
        // used as an owner-observable refresh signal.
        await this.store.enableHeartbeat(jobId, ownerId);
        heartbeatOptedIn = true;
      }
      if (this.store.refreshHeartbeat) {
        const refreshed = await this.store.refreshHeartbeat(jobId, ownerId);
        if (!refreshed) throw new JobOwnershipLostError(jobId, ownerId);
      } else {
        // Compatibility fallback for published v5 stores. Implementations
        // should owner-scope this write, but legacy no-op mismatch behavior
        // cannot provide observable ownership loss.
        await this.store.heartbeat(jobId, ownerId);
      }
    };

    const scheduleHeartbeat = (): void => {
      if (heartbeatStopped || this.heartbeatMs === undefined) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        const attempt = (async () => {
          try {
            await withTimeout(
              Promise.resolve().then(() => refreshOwnedHeartbeat()),
              this.heartbeatTimeoutMs!,
              `Heartbeat for job ${jobId} timed out after ${this.heartbeatTimeoutMs}ms`,
            );
          } catch (error: unknown) {
            recordHeartbeatFailure(error);
          }
        })();
        heartbeatInFlight = attempt;
        void attempt.then(() => {
          if (heartbeatInFlight === attempt) heartbeatInFlight = null;
          if (!heartbeatStopped) scheduleHeartbeat();
        });
      }, this.heartbeatMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    };

    const stopHeartbeats = async (): Promise<void> => {
      heartbeatStopped = true;
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (heartbeatInFlight) await heartbeatInFlight;
    };

    const ensureCancellationRequested = async (reason: string): Promise<void> => {
      if (!entry.cancellationRequested) {
        entry.cancelReason = reason;
        const request = entry.claim.then(async (claimed) => {
          if (!claimed) return;
          await this.appendLive(jobId, { type: 'cancellation_requested', reason });
        });
        entry.cancellationRequested = request;
        void request.catch(() => undefined);
      }
      await entry.cancellationRequested;
    };

    const persistCancellation = async (reason: string): Promise<unknown[]> => {
      const failures: unknown[] = [];
      try {
        await ensureCancellationRequested(reason);
      } catch (error: unknown) {
        failures.push(error);
      }
      // The terminal transition must still be attempted when request-event
      // persistence fails; otherwise an auditable failure could strand a live
      // RUNNING row after its owner has already aborted.
      try {
        const terminal = await this.store.finalizeJob(jobId, {
          status: 'CANCELLED',
          error: reason,
          event: { type: 'cancelled', reason },
          ownerId,
        });
        if (terminal) this.emitRecord(terminal);
      } catch (error: unknown) {
        failures.push(error);
      }
      return failures;
    };

    const persistFailure = async (message: string): Promise<unknown[]> => {
      try {
        const terminal = await this.store.finalizeJob(jobId, {
          status: 'FAILED',
          error: message,
          event: { type: 'error', message },
          ownerId,
        });
        if (terminal) this.emitRecord(terminal);
        return [];
      } catch (error: unknown) {
        return [error];
      }
    };

    try {
      const claimed = await entry.claim;
      if (!claimed) throw new Error(`Job ${jobId} is already owned or terminal`);
      ownershipAcquired = true;
      ctx.heartbeat = async () => {
        // A pipeline using only manual heartbeats opts into stale detection on
        // first use, without requiring heartbeatMs at runner construction.
        try {
          const refresh = Promise.resolve().then(() => refreshOwnedHeartbeat());
          if (this.heartbeatTimeoutMs === undefined) await refresh;
          else await withTimeout(
            refresh,
            this.heartbeatTimeoutMs,
            `Heartbeat for job ${jobId} timed out after ${this.heartbeatTimeoutMs}ms`,
          );
        } catch (error: unknown) {
          const failure = error instanceof Error ? error : new Error(String(error));
          recordHeartbeatFailure(failure);
          throw failure;
        }
      };

      // An explicit per-run false is an opt-out even when the runner has a
      // default interval. Manual ctx.heartbeat() remains available for callers
      // that later choose to opt in explicitly.
      if (this.heartbeatMs !== undefined && ownership.heartbeatEnabled !== false) {
        scheduleHeartbeat();
      }

      for await (const event of runPipeline<TCtx, TEvent>(phases, ctx, { signal })) {
        const pipelineEvent = event as PipelineEvent;
        if (pipelineEvent.type === 'done') {
          stopReason = (pipelineEvent as { reason?: string }).reason;
        } else if (pipelineEvent.type !== 'cancelled') {
          await this.appendLive(jobId, pipelineEvent);
          eventCount++;
        }
        if (signal.aborted) {
          const reason = signalReasonToString(signal, 'cancelled');
          const error = new Error(`cancelled: ${reason}`);
          error.name = 'AbortError';
          throw error;
        }
      }

      const drainFailures = await drainResources();
      await stopHeartbeats();
      if (entry.terminationCause === 'heartbeat') {
        throw heartbeatFailure;
      }
      if (signal.aborted) {
        const reason = signalReasonToString(signal, entry.cancelReason ?? 'cancelled');
        const error = new Error(`cancelled: ${reason}`);
        error.name = 'AbortError';
        throw error;
      }
      if (drainFailures.length > 0) {
        throw new LifecycleDrainAggregateError(drainFailures);
      }

      const result = finalResult ? finalResult() : null;
      // finalResult is host code and may synchronously request cancellation or
      // abort the caller signal. Cancellation remains authoritative until the
      // completion intent is committed below.
      if (entry.terminationCause === 'cancellation' || signal.aborted) {
        const reason = signalReasonToString(signal, entry.cancelReason ?? 'cancelled');
        const error = new Error(`cancelled: ${reason}`);
        error.name = 'AbortError';
        throw error;
      }
      const doneEvent: PipelineEvent = stopReason === undefined
        ? { type: 'done' }
        : { type: 'done', reason: stopReason };
      // Commit the local terminal intent before the asynchronous store call.
      // Cancellation requested after this boundary is rejected rather than
      // producing a cancellation-requested event behind a completed job.
      entry.terminationCause = 'completion';
      const completed = await this.store.finalizeJob(jobId, {
        status: 'COMPLETED',
        result,
        event: doneEvent,
        ownerId,
      });
      if (!completed) throw new Error(`Job ${jobId} reached success after another terminal transition`);
      this.emitRecord(completed);
      eventCount++;
      return stopReason !== undefined
        ? { status: 'stopped', reason: stopReason, eventCount }
        : { status: 'completed', eventCount };
    } catch (error: unknown) {
      if (!entry.terminationCause) {
        entry.terminationCause = signal.aborted ? 'cancellation' : 'pipeline';
      }
      const drainFailures = await drainResources();
      await stopHeartbeats();
      if (!ownershipAcquired) {
        throw combineLifecycleErrors(error, drainFailures);
      }
      if (entry.terminationCause === 'cancellation') {
        const reason = signalReasonToString(signal, entry.cancelReason ?? 'cancelled');
        const persistenceFailures = await persistCancellation(reason);
        const abort = error instanceof Error && error.name === 'AbortError'
          ? error
          : Object.assign(new Error(`cancelled: ${reason}`), { name: 'AbortError' });
        throw combineLifecycleErrors(abort, [...persistenceFailures, ...drainFailures]);
      }
      const effectiveError = entry.terminationCause === 'heartbeat'
        ? heartbeatFailure
        : error;
      const primaryError = effectiveError instanceof LifecycleDrainAggregateError
        ? effectiveError
        : combineLifecycleErrors(effectiveError, drainFailures);
      const message = effectiveError instanceof Error
        ? effectiveError.message
        : String(effectiveError);
      const persistenceFailures = await persistFailure(message);
      throw appendLifecycleErrors(primaryError, persistenceFailures);
    } finally {
      this.inflight.delete(jobId);
      this.activeContexts.delete(ctx);
      await stopHeartbeats();
      try { previousSignal?.removeEventListener('abort', markCallerCancellation); }
      catch { /* Preserve the authoritative lifecycle result. */ }
      // Context accessors are host code. Restoration failures must not replace
      // the pipeline/cancellation result after its durable lifecycle decision.
      try { ctx.signal = previousSignal; }
      catch { /* Preserve the authoritative lifecycle result. */ }
      try { ctx.heartbeat = previousHeartbeat; }
      catch { /* Preserve the authoritative lifecycle result. */ }
    }
  }

  private assertLocalAvailability(jobId: string, ctx: BasePipelineContext): void {
    if (this.inflight.has(jobId)) throw new Error(`Job ${jobId} is already running on this runner`);
    if (this.activeContexts.has(ctx)) {
      throw new Error('The same pipeline context cannot be used by concurrent JobRunner runs');
    }
  }

  private async appendLive(jobId: string, event: PipelineEvent): Promise<void> {
    const eventId = await this.store.appendEvent(jobId, event);
    this.emitRecord({
      id: eventId,
      jobId,
      eventType: event.type,
      data: event,
      createdAt: new Date(),
    });
  }

  private emitRecord(record: { id: number; jobId: string; eventType: string; data: PipelineEvent; createdAt: Date }): void {
    const event: LiveEvent = Object.freeze({
      id: record.id,
      jobId: record.jobId,
      eventType: record.eventType,
      data: record.data,
      createdAt: record.createdAt.toISOString(),
    });
    // EventEmitter's default dispatch lets listener failures escape. Lifecycle
    // observation is best-effort: snapshot listeners, isolate synchronous
    // throws, and observe returned promise rejections without granting either
    // authority over persisted state or pipeline results.
    for (const listener of this.rawListeners(`job:${record.jobId}`)) {
      try {
        const result = Reflect.apply(listener, this, [event]) as unknown;
        void Promise.resolve(result).catch((error: unknown) => {
          this.reportLiveListenerError(event, error);
        });
      } catch (error: unknown) {
        this.reportLiveListenerError(event, error);
      }
    }
  }

  private reportLiveListenerError(event: LiveEvent, error: unknown): void {
    if (!this.onLiveEventError) return;
    const failure: LiveEventListenerFailure = Object.freeze({
      event,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    try {
      void Promise.resolve(this.onLiveEventError(failure)).catch(() => undefined);
    } catch {
      // The failure observer is a terminal diagnostic sink.
    }
  }
}

class LifecycleDrainAggregateError extends AggregateError {
  constructor(failures: ReadonlyArray<unknown>) {
    super(failures, 'One or more lifecycle drains failed');
  }
}

function combineLifecycleErrors(primary: unknown, drainFailures: ReadonlyArray<unknown>): unknown {
  if (drainFailures.length === 0) return primary;
  const message = primary instanceof Error ? primary.message : String(primary);
  const combined = new AggregateError([primary, ...drainFailures], message);
  if (primary instanceof Error && primary.name === 'AbortError') combined.name = 'AbortError';
  return combined;
}

function appendLifecycleErrors(primary: unknown, additional: ReadonlyArray<unknown>): unknown {
  if (additional.length === 0) return primary;
  if (primary instanceof AggregateError) {
    const combined = new AggregateError([...primary.errors, ...additional], primary.message);
    combined.name = primary.name;
    return combined;
  }
  return combineLifecycleErrors(primary, additional);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Keep this timer referenced: terminal persistence and context cleanup
    // depend on it when a backend heartbeat never settles.
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function safeReadPid(): number | undefined {
  try { return typeof process !== 'undefined' ? process.pid : undefined; }
  catch { return undefined; }
}

function safeReadPpid(): number | undefined {
  try { return typeof process !== 'undefined' ? process.ppid : undefined; }
  catch { return undefined; }
}

function safeReadCwd(): string | undefined {
  try {
    return typeof process !== 'undefined' && typeof process.cwd === 'function'
      ? process.cwd()
      : undefined;
  } catch { return undefined; }
}

function safeReadHostname(): string | undefined {
  try { return os.hostname(); }
  catch { return undefined; }
}
