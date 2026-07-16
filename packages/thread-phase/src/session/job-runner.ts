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
import type {
  EventRecord,
  JobFinalization,
  JobOwnership,
  JobStore,
  OwnedHeartbeatJobStoreCapabilities,
  OwnedJobStoreCapabilities,
} from './job-store.js';
import { signalReasonToString } from '../internal/error-message.js';

export interface LiveEvent {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: string;
}

export interface JobRunnerOptions {
  /** Automatic heartbeat interval for active runs. */
  heartbeatMs?: number;
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
}

export class JobRunner extends EventEmitter {
  private inflight = new Map<string, InflightRun>();
  private activeContexts = new WeakSet<object>();
  private readonly heartbeatMs?: number;

  constructor(private readonly store: JobStore, options: JobRunnerOptions = {}) {
    super();
    this.setMaxListeners(100);
    if (
      options.heartbeatMs !== undefined &&
      (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs < 1)
    ) {
      throw new RangeError('heartbeatMs must be a positive safe integer');
    }
    this.heartbeatMs = options.heartbeatMs;
  }

  /** Explicit unscoped heartbeat for operator-driven recovery workflows. */
  heartbeat(jobId: string): Promise<void> {
    return this.store.heartbeat(jobId);
  }

  create(name: string, input: unknown): Promise<string> {
    return this.store.createJob(name, input);
  }

  signalFor(jobId: string): AbortSignal | undefined {
    return this.inflight.get(jobId)?.signal;
  }

  /**
   * Start a run and return its cancellation signal/result immediately.
   * The job row must already exist; call {@link create} first.
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
    const signal = this.signalFor(jobId);
    if (!signal) throw new Error(`JobRunner failed to initialize run ${jobId}`);
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
    if (!entry) return false;
    if (!entry.cancellationRequested) {
      entry.cancelReason = reason;
      entry.cancellationRequested = entry.claim.then(async (claimed) => {
        if (!claimed) return;
        await this.appendLive(jobId, { type: 'cancellation_requested', reason });
      }).catch(() => undefined);
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
    while (true) {
      const stale = await this.store.listJobs({ status: 'STALE', staleAfterMs, limit: 100 });
      if (stale.length === 0) break;
      let transitioned = 0;
      for (const job of stale) {
        const terminal = hasOwnedLifecycle(this.store)
          ? await this.store.finalizeAbandonedIfStale(
            job.id,
            staleBefore,
            reason,
            job.ownerId,
          )
          : await this.finalizeLegacyAbandoned(job.id, reason);
        if (!terminal) continue;
        transitioned++;
        this.emitRecord(terminal);
        reconciled.push(job.id);
      }
      // Avoid an infinite loop with a backend whose stale snapshot is not
      // refreshed or whose conditional transition rejects every candidate.
      if (transitioned === 0 || stale.length < 100) break;
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
    this.activeContexts.add(ctx);

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
    const entry: InflightRun = {
      controller,
      signal,
      // Replaced by the real acquisition promise before run() first yields.
      // The placeholder keeps cancellation safe while lifecycle setup remains
      // entirely synchronous.
      claim: Promise.resolve(false),
    };
    this.inflight.set(jobId, entry);
    ctx.signal = signal;

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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

    const ensureCancellationRequested = async (reason: string): Promise<void> => {
      if (!entry.cancellationRequested) {
        entry.cancelReason = reason;
        entry.cancellationRequested = entry.claim.then(async (claimed) => {
          if (!claimed) return;
          await this.appendLive(jobId, { type: 'cancellation_requested', reason });
        }).catch(() => undefined);
      }
      await entry.cancellationRequested;
    };

    const persistCancellation = async (reason: string): Promise<void> => {
      await ensureCancellationRequested(reason);
      const terminal = await this.finalizeWithFallback(jobId, {
        status: 'CANCELLED',
        error: reason,
        event: { type: 'cancelled', reason },
        ownerId,
      });
      if (terminal) this.emitRecord(terminal);
    };

    const persistFailure = async (message: string): Promise<void> => {
      const terminal = await this.finalizeWithFallback(jobId, {
        status: 'FAILED',
        error: message,
        event: { type: 'error', message },
        ownerId,
      });
      if (terminal) this.emitRecord(terminal);
    };

    try {
      // Custom stores can throw before returning their declared Promise. Keep
      // both the additive owned path and the v5.0.0 legacy path inside the
      // protected lifecycle so those failures still drain and restore hooks.
      entry.claim = hasOwnedLifecycle(this.store)
        ? this.store.claimRunning(jobId, ownership)
        : this.store.setRunning(jobId, ownership).then(() => true);
      const claimed = await entry.claim;
      if (!claimed) throw new Error(`Job ${jobId} is already owned or terminal`);
      ownershipAcquired = true;
      ctx.heartbeat = async () => {
        // A pipeline using only manual heartbeats opts into stale detection on
        // first use, without requiring heartbeatMs at runner construction.
        if (hasOwnedHeartbeat(this.store)) {
          const enabled = await this.store.enableHeartbeat(jobId, ownerId);
          if (!enabled) throw new Error(`Job ${jobId} is no longer owned by ${ownerId}`);
        } else {
          await this.store.heartbeat(jobId);
        }
      };

      if (this.heartbeatMs !== undefined && this.heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          const heartbeat = hasOwnedHeartbeat(this.store)
            ? this.store.heartbeatOwned(jobId, ownerId)
            : this.store.heartbeat(jobId);
          void heartbeat.catch(() => undefined);
        }, this.heartbeatMs);
        if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
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
      const doneEvent: PipelineEvent = stopReason === undefined
        ? { type: 'done' }
        : { type: 'done', reason: stopReason };
      const completed = await this.finalizeWithFallback(jobId, {
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
      const drainFailures = await drainResources();
      if (!ownershipAcquired) {
        throw combineLifecycleErrors(error, drainFailures);
      }
      if (signal.aborted) {
        const reason = signalReasonToString(signal, entry.cancelReason ?? 'cancelled');
        await persistCancellation(reason);
        const abort = error instanceof Error && error.name === 'AbortError'
          ? error
          : Object.assign(new Error(`cancelled: ${reason}`), { name: 'AbortError' });
        throw combineLifecycleErrors(abort, drainFailures);
      }
      const primaryError = error instanceof LifecycleDrainAggregateError
        ? error
        : combineLifecycleErrors(error, drainFailures);
      const message = error instanceof Error ? error.message : String(error);
      await persistFailure(message);
      throw primaryError;
    } finally {
      this.inflight.delete(jobId);
      this.activeContexts.delete(ctx);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      ctx.signal = previousSignal;
      ctx.heartbeat = previousHeartbeat;
    }
  }

  private async finalizeWithFallback(
    jobId: string,
    finalization: JobFinalization,
  ): Promise<EventRecord | null> {
    if (hasOwnedLifecycle(this.store)) {
      return this.store.finalizeJob(jobId, finalization);
    }

    // v5.0.0 stores predate atomic finalization and distinct cancellation.
    // Preserve their lifecycle contract while still emitting the new terminal
    // event: cancellation falls back to FAILED, as it did in v5.0.0.
    if (finalization.status === 'COMPLETED') {
      await this.store.setCompleted(jobId, finalization.result ?? null);
    } else {
      const message = finalization.status === 'CANCELLED'
        ? `cancelled: ${finalization.error ?? 'cancelled'}`
        : finalization.error ?? finalization.status.toLowerCase();
      await this.store.setFailed(jobId, message);
    }
    return this.appendRecord(jobId, finalization.event);
  }

  private async finalizeLegacyAbandoned(jobId: string, reason: string): Promise<EventRecord> {
    await this.store.setFailed(jobId, reason);
    return this.appendRecord(jobId, { type: 'abandoned', reason });
  }

  private async appendRecord(jobId: string, event: PipelineEvent): Promise<EventRecord> {
    const id = await this.store.appendEvent(jobId, event);
    return {
      id,
      jobId,
      eventType: event.type,
      data: event,
      createdAt: new Date(),
    };
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
    this.emit(`job:${record.jobId}`, {
      id: record.id,
      jobId: record.jobId,
      eventType: record.eventType,
      data: record.data,
      createdAt: record.createdAt.toISOString(),
    } satisfies LiveEvent);
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

function hasOwnedLifecycle(store: JobStore): store is JobStore & OwnedJobStoreCapabilities {
  const candidate = store as Partial<OwnedJobStoreCapabilities>;
  return typeof candidate.claimRunning === 'function'
    && typeof candidate.finalizeJob === 'function'
    && typeof candidate.finalizeAbandonedIfStale === 'function';
}

function hasOwnedHeartbeat(store: JobStore): store is JobStore & OwnedHeartbeatJobStoreCapabilities {
  const candidate = store as Partial<OwnedHeartbeatJobStoreCapabilities>;
  return typeof candidate.heartbeatOwned === 'function'
    && typeof candidate.enableHeartbeat === 'function';
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
