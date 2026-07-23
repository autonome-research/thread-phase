/**
 * sqlite-backed JobStore implementation — the bundled default.
 *
 * Two tables (job, event) on a single sqlite file. WAL journal for write
 * concurrency, foreign keys enforced.
 *
 * The interface (`JobStore`) is async-by-default in v3.0.0; this
 * implementation wraps its sync better-sqlite3 calls in `async` methods.
 * better-sqlite3 stays sync internally — the only overhead is one
 * microtask per call, which is negligible against sqlite's already
 * sub-millisecond write cost. We pay this cost to keep one unified
 * interface across all backends (Postgres, Redis, network stores)
 * instead of two parallel sync + async hierarchies.
 */
import type { PipelineEvent } from '../phase.js';
import type { EventRecord, GetJobOptions, JobFinalization, JobOwnership, JobRecord, JobStore, ListJobsOptions } from './job-store.js';
export declare class SqliteJobStore implements JobStore {
    private db;
    constructor(dbPath?: string);
    /**
     * Apply any unapplied migrations. Reads `PRAGMA user_version`, applies
     * each entry from `MIGRATIONS` whose version is greater, inside a
     * transaction per step, then bumps user_version.
     *
     * Idempotent: running twice is a no-op once the schema is current.
     */
    private runMigrations;
    createJob(name: string, input: unknown): Promise<string>;
    acquireExclusive(name: string, input: unknown): Promise<string | null>;
    setRunning(jobId: string, ownership?: JobOwnership): Promise<boolean>;
    heartbeat(jobId: string, ownerId?: string): Promise<void>;
    enableHeartbeat(jobId: string, ownerId: string): Promise<boolean>;
    setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean>;
    setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean>;
    setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean>;
    setAbandoned(jobId: string, reason: string): Promise<boolean>;
    setAbandonedIfStale(jobId: string, staleBefore: Date, reason: string, expectedOwnerId?: string): Promise<boolean>;
    finalizeJob(jobId: string, finalization: JobFinalization): Promise<EventRecord | null>;
    finalizeAbandonedIfStale(jobId: string, staleBefore: Date, reason: string, expectedOwnerId?: string): Promise<EventRecord | null>;
    getJob(jobId: string, options?: GetJobOptions): Promise<JobRecord | null>;
    listJobs(options?: ListJobsOptions): Promise<JobRecord[]>;
    /**
     * Translate a row to a JobRecord, computing the read-time STALE status
     * when the caller requested staleness detection and this row qualifies.
     * The persisted `status` column is never modified by reads.
     */
    private toJobRecord;
    appendEvent(jobId: string, event: PipelineEvent): Promise<number>;
    getEvents(jobId: string, afterId?: number): Promise<EventRecord[]>;
    private toEventRecord;
    close(): void;
}
//# sourceMappingURL=sqlite-job-store.d.ts.map