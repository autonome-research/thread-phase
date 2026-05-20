/**
 * JobStore interface — the persistence boundary for thread-phase jobs and
 * their event logs.
 *
 * SqliteJobStore is the bundled default (single-file, zero-config). Other
 * backends (in-memory for tests, custom file-based for embedded use) just
 * need to implement this interface.
 *
 * # v1 stability commitment: sync interface
 *
 * Methods are synchronous on purpose. Three reasons:
 *
 *   1. Hot path: the agent runner persists events at every tool-call
 *      boundary. With sqlite + WAL, a sync write is sub-millisecond and
 *      doesn't add a microtask. Awaiting per-event would slow tight
 *      fanouts (50-100 items × multiple events each) for no real benefit.
 *
 *   2. Single-process is the v1 sweet spot. The bundled SqliteJobStore
 *      assumes one writer per database file (WAL handles same-DB
 *      co-tenancy with separate connections, but there's no distributed
 *      coordination). Going async to enable Postgres without an
 *      established demand would be paying a real cost for hypothetical
 *      flexibility.
 *
 *   3. Future async backends are an additive change, not a breaking one.
 *      When a real consumer needs Postgres-backed jobs (e.g. multi-process
 *      workers sharing state), the right move is to add a `JobStoreAsync`
 *      interface as a *second* type and let `JobRunner` accept either via
 *      method overload. Existing sync users keep their hot path; async
 *      users opt in. That migration is mechanical, not breaking.
 *
 * If you're implementing a custom backend and your underlying I/O is async
 * (e.g. a network call), wrap it with a small in-process queue + flush
 * loop so the JobStore methods themselves remain sync. The agent runner's
 * fire-and-forget pattern tolerates eventual consistency for events as
 * long as the final state (job status, completion result) is durable
 * before `setCompleted` returns.
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
  createJob(name: string, input: unknown): string;
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
  acquireExclusive(name: string, input: unknown): string | null;
  setRunning(jobId: string): void;
  setCompleted(jobId: string, result: unknown): void;
  setFailed(jobId: string, error: string): void;

  getJob(jobId: string): JobRecord | null;
  listJobs(options?: ListJobsOptions): JobRecord[];

  /** Append one event to the log; returns its monotonic id (resume cursor). */
  appendEvent(jobId: string, event: PipelineEvent): number;
  /** Read events. `afterId` is the resume cursor — use 0 for "from the start". */
  getEvents(jobId: string, afterId?: number): EventRecord[];

  close(): void;
}
