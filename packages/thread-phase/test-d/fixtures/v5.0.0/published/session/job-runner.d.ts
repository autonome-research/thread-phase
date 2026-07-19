/**
 * Job runner — persistent execution, live events, cancellation, and liveness.
 *
 * JobRunner owns the authoritative lifecycle for one in-process pipeline run.
 * It composes its cancellation signal with any caller-provided ctx.signal,
 * persists cancellation separately from failure, and guarantees that terminal
 * store transitions cannot overwrite one another.
 */
import { EventEmitter } from 'events';
import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';
import { type PipelineSummary } from '../orchestrator.js';
import type { JobOwnership, JobStore } from './job-store.js';
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
export interface JobRunOptions {
    /** Caller-supplied logical session id recorded on the JobRecord. */
    sessionId?: string;
    /** Additional or overridden ownership metadata. */
    ownership?: JobOwnership;
    /** Host-defined source such as `pi-tool`, `cron`, or `webhook`. */
    launchSource?: string;
}
/** Immediate handle returned by {@link JobRunner.start}. */
export interface JobRunHandle {
    readonly jobId: string;
    readonly signal: AbortSignal;
    readonly result: Promise<PipelineSummary>;
    cancel(reason?: string): void;
}
export declare class JobRunner extends EventEmitter {
    private readonly store;
    private inflight;
    private activeContexts;
    private readonly heartbeatMs?;
    constructor(store: JobStore, options?: JobRunnerOptions);
    heartbeat(jobId: string): Promise<void>;
    create(name: string, input: unknown): Promise<string>;
    signalFor(jobId: string): AbortSignal | undefined;
    /**
     * Start a run and return its cancellation signal/result immediately.
     * The job row must already exist; call {@link create} first.
     */
    start<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(jobId: string, phases: ReadonlyArray<Phase<TCtx, TEvent>>, ctx: TCtx, finalResult?: () => unknown, options?: JobRunOptions): JobRunHandle;
    /**
     * Request cancellation. The request is persisted before terminal
     * cancellation is finalized. Returns false when no local run owns jobId.
     */
    cancel(jobId: string, reason?: string): boolean;
    /**
     * Convert read-time stale jobs into durable ABANDONED terminal records.
     * A separate operator/host decides how often reconciliation runs.
     */
    reconcileAbandoned(staleAfterMs: number, reason?: string): Promise<string[]>;
    run<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(jobId: string, phases: ReadonlyArray<Phase<TCtx, TEvent>>, ctx: TCtx, finalResult?: () => unknown, options?: JobRunOptions): Promise<PipelineSummary>;
    private assertLocalAvailability;
    private appendLive;
    private emitRecord;
}
//# sourceMappingURL=job-runner.d.ts.map