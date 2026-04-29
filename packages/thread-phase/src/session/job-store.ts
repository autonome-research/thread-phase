/**
 * JobStore interface — the persistence boundary for thread-phase jobs and
 * their event logs.
 *
 * SqliteJobStore is the bundled default (single-file, zero-config). Other
 * backends (Postgres for shared multi-process state, in-memory for tests)
 * just need to implement this interface.
 *
 * Methods are intentionally synchronous: most callers (especially the agent
 * runner persisting events) want fire-and-forget writes that don't block the
 * event loop on every step. A future async backend can wrap async I/O behind
 * a sync façade or, if breaking the contract is acceptable, the interface
 * can evolve to Promise-returning methods. For now, keep it simple.
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
