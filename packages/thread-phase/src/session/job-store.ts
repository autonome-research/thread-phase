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

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

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
}

export interface EventRecord {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: Date;
}

export interface ListJobsOptions {
  /** Filter to a single pipeline name. */
  name?: string;
  /** Page size cap. Default: 50. */
  limit?: number;
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
  setRunning(jobId: string): Promise<void>;
  setCompleted(jobId: string, result: unknown): Promise<void>;
  setFailed(jobId: string, error: string): Promise<void>;

  getJob(jobId: string): Promise<JobRecord | null>;
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
