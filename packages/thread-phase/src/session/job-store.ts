/**
 * JobStore interface — the persistence boundary for thread-phase jobs and
 * their event logs.
 *
 * SqliteJobStore is the bundled default (single-file, zero-config). Other
 * backends (Postgres, Redis, custom file-based for embedded use) just
 * need to implement this interface.
 *
 * # v3 interface: async by default
 *
 * Every method returns a Promise. This is the breaking change in v3.0.0:
 * pre-v3 the interface was sync (sqlite hot path; fire-and-forget event
 * writes) and that blocked any backend whose underlying I/O is async
 * (Postgres, Redis, network-attached stores). Going async at the
 * interface level unblocks those backends without forcing them to fake
 * a sync boundary via in-process queues.
 *
 * Performance note for SqliteJobStore: better-sqlite3 stays sync
 * internally; the bundled implementation just wraps its prepared-
 * statement calls in `async` methods. The added cost is one microtask
 * per call — sub-microsecond, swamped by the actual I/O on every other
 * backend, and negligible on sqlite given the prior sub-millisecond
 * write cost.
 *
 * Migration from v2: every `store.xxx(...)` call site needs `await`.
 * `JobRunner` and `streamToSSE` handle this internally; user code that
 * touched the store directly (custom dashboards, replay scripts) needs
 * to add `await` and become `async` at the call site.
 *
 * `close()` is the one exception — it stays sync because closing isn't
 * a perf-sensitive code path and several embedded backends (sqlite,
 * in-memory) have no async work to do on close. Implementations whose
 * close is genuinely async can still return a Promise; the type allows
 * either (`void | Promise<void>` is the relaxation).
 */

import type { PipelineEvent } from '../phase.js';

/**
 * Persisted job lifecycle states + the computed read-time `'STALE'`
 * discriminant.
 *
 * `'STALE'` is NEVER written to the store. It appears only as a
 * read-time computed status when callers pass `staleAfterMs` to
 * `getJob()` or `listJobs()` and the row meets the staleness criteria
 * (status = RUNNING AND heartbeatAt is older than the threshold).
 * The persisted status of any STALE-reported row is still RUNNING —
 * the caller decides whether to transition it to ABANDONED (for example via
 * `JobRunner.reconcileAbandoned`).
 */
export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'STALE';

/** Stable failure raised when an owner-scoped operation no longer owns a RUNNING job. */
export class JobOwnershipLostError extends Error {
  readonly code = 'ERR_JOB_OWNERSHIP_LOST';

  constructor(
    readonly jobId: string,
    readonly ownerId: string,
  ) {
    super(`Job ${jobId} is no longer owned by ${ownerId}`);
    this.name = 'JobOwnershipLostError';
  }
}

export interface JobRecord {
  id: string;
  name: string;
  input: unknown;
  status: JobStatus;
  result: unknown | null;
  error: string | null;
  eventCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  // Optional ownership / liveness metadata. Auto-populated by JobRunner at
  // setRunning() time when the runtime exposes the source (process.pid etc).
  // sessionId is caller-supplied via JobRunner.run options. heartbeatAt is
  // updated by JobRunner.heartbeat() and used for read-time staleness.
  /** Caller-supplied logical session id (e.g. CLI invocation, request id). */
  sessionId?: string;
  /** OS process id of the owning runtime (process.pid). */
  pid?: number;
  /** Parent process id (process.ppid). */
  ppid?: number;
  /** Working directory at setRunning() time (process.cwd()). */
  cwd?: string;
  /** Hostname at setRunning() time (os.hostname()). */
  hostname?: string;
  /** Unique identity for this process/run ownership claim. */
  ownerId?: string;
  /** Application-defined source, e.g. `pi-tool`, `cron`, or `webhook`. */
  launchSource?: string;
  /**
   * Whether this run opted into heartbeat-based stale reconciliation.
   * In JobRunner ownership options, explicit false also suppresses that run's
   * automatic interval; a later manual ctx.heartbeat() can opt in.
   */
  heartbeatEnabled?: boolean;
  /** Most recent heartbeat ISO timestamp. Updated by JobRunner.heartbeat(). */
  heartbeatAt?: Date;
}

export interface EventRecord {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: Date;
}

export interface JobFinalization {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';
  result?: unknown;
  error?: string;
  event: PipelineEvent;
  ownerId?: string;
}

export interface ListJobsOptions {
  /** Filter to a single pipeline name. */
  name?: string;
  /** Page size cap. Default: 50. */
  limit?: number;
  /**
   * Filter to a specific status. When set to `'STALE'`, callers MUST also
   * pass `staleAfterMs`; otherwise no jobs match (STALE is never persisted).
   */
  status?: JobStatus;
  /**
   * Read-time staleness threshold in milliseconds. When set, RUNNING jobs
   * whose `heartbeatAt` is older than `Date.now() - staleAfterMs` are
   * surfaced with `status: 'STALE'` in the returned records. The
   * persisted status is NOT modified — implementations compute STALE on
   * read only. Has no effect on PENDING or terminal rows.
   *
   * If your runs do not heartbeat (no `heartbeatMs` on JobRunner, no
   * manual `ctx.heartbeat?.()` calls), staleness can not be detected —
   * RUNNING jobs are assumed live regardless of `startedAt`.
   */
  staleAfterMs?: number;
}

/** Options for {@link JobStore.getJob}. */
export interface GetJobOptions {
  /** See {@link ListJobsOptions.staleAfterMs}. */
  staleAfterMs?: number;
}

/** Ownership metadata recorded at setRunning() time. All fields optional. */
export interface JobOwnership {
  sessionId?: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  hostname?: string;
  ownerId?: string;
  launchSource?: string;
  heartbeatEnabled?: boolean;
}

export interface JobStore {
  /** Insert a PENDING job row, return its id. */
  createJob(name: string, input: unknown): Promise<string>;
  /**
   * Atomically claim a single-runner slot for `name`. If no job with this
   * name is currently RUNNING, insert a new job row directly in RUNNING
   * state and return its id. Otherwise return null.
   *
   * Use this for cron-driven pipelines that should never overlap with
   * themselves (e.g. a 10-minute timer where a run can occasionally take
   * longer than the interval). Implementations must perform the
   * existence check + insert in a single transaction.
   *
   * `JobRunner.run` will still call setRunning on the returned id; that's
   * a no-op state transition and (with the COALESCE in setRunning) leaves
   * the original startedAt intact.
   */
  acquireExclusive(name: string, input: unknown): Promise<string | null>;
  /**
   * Transition a row from PENDING to RUNNING. Optionally records
   * ownership metadata (sessionId, pid, ppid, cwd, hostname) so
   * downstream operators can answer "which process owns this job."
   */
  /** Atomically claim PENDING/unowned work. False means another owner won. */
  setRunning(jobId: string, ownership?: JobOwnership): Promise<boolean>;
  /**
   * Terminal transitions are atomic first-writer-wins operations. They return
   * true only when this call changed a PENDING/RUNNING row; custom stores must
   * not overwrite an existing terminal status.
   */
  setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean>;
  setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean>;
  /** Persist a cooperative or forced user/system cancellation. */
  setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean>;
  /** Persist an explicit owner-loss decision for a RUNNING job. */
  setAbandoned(jobId: string, reason: string): Promise<boolean>;
  /**
   * Atomically abandon a job only if it is still RUNNING, still owned by the
   * expected owner (when supplied), and its heartbeat remains older than the
   * cutoff. Prevents a stale-list/read race from abandoning a recovered job.
   */
  setAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<boolean>;
  /** Atomically persist one terminal transition and its terminal event. */
  finalizeJob(jobId: string, finalization: JobFinalization): Promise<EventRecord | null>;
  /** Atomic stale-check + ABANDONED transition + event append. */
  finalizeAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<EventRecord | null>;
  /**
   * Update `heartbeatAt` to "now." Available for direct integrations,
   * legacy JobRunner refresh fallback, and explicit unscoped operator refreshes.
   *
   * Implementations should scope updates to `ownerId` when supplied. As in
   * published v5.0.0, a non-running or mismatched row may remain a no-op.
   * Unscoped calls are an operator override.
   */
  heartbeat(jobId: string, ownerId?: string): Promise<void>;
  /** Atomically opt an owned run into stale detection and refresh heartbeat. */
  enableHeartbeat(jobId: string, ownerId: string): Promise<boolean>;
  /**
   * Optional v5.1 owner-observable refresh capability. Unlike the published
   * v5.0 enable operation, repeated calls must return true for the same owned
   * RUNNING row and false when that owner no longer controls it.
   */
  refreshHeartbeat?(jobId: string, ownerId: string): Promise<boolean>;

  getJob(jobId: string, options?: GetJobOptions): Promise<JobRecord | null>;
  listJobs(options?: ListJobsOptions): Promise<JobRecord[]>;

  /** Append one event to the log; returns its monotonic id (resume cursor). */
  appendEvent(jobId: string, event: PipelineEvent): Promise<number>;
  /** Read events. `afterId` is the resume cursor — use 0 for "from the start". */
  getEvents(jobId: string, afterId?: number): Promise<EventRecord[]>;

  /**
   * Release any underlying resources (connections, file handles). May be
   * sync or async — implementations whose close has no async work
   * (sqlite, in-memory) may return void; networked backends should return
   * a Promise that resolves when the connection is fully torn down.
   */
  close(): void | Promise<void>;
}
