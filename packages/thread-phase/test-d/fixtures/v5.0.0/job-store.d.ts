/*
 * JobStore compatibility baseline transcribed from the generated declarations
 * at a3095837a62acdeac1922eecfdf38890437eb116, immediately before the v5
 * owned-lifecycle work. This fixture deliberately does not import current
 * JobStore declarations.
 */
import type { PipelineEvent } from './phase.js';

export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'STALE';

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
  sessionId?: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  hostname?: string;
  ownerId?: string;
  launchSource?: string;
  heartbeatEnabled?: boolean;
  heartbeatAt?: Date;
}

export interface EventRecord {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: Date;
}

export interface ListJobsOptions {
  name?: string;
  limit?: number;
  status?: JobStatus;
  staleAfterMs?: number;
}

export interface GetJobOptions {
  staleAfterMs?: number;
}

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
  createJob(name: string, input: unknown): Promise<string>;
  acquireExclusive(name: string, input: unknown): Promise<string | null>;
  setRunning(jobId: string, ownership?: JobOwnership): Promise<void>;
  setCompleted(jobId: string, result: unknown): Promise<void>;
  setFailed(jobId: string, error: string): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
  getJob(jobId: string, options?: GetJobOptions): Promise<JobRecord | null>;
  listJobs(options?: ListJobsOptions): Promise<JobRecord[]>;
  appendEvent(jobId: string, event: PipelineEvent): Promise<number>;
  getEvents(jobId: string, afterId?: number): Promise<EventRecord[]>;
  close(): void | Promise<void>;
}
