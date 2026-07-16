import type {
  EventRecord,
  GetJobOptions,
  JobFinalization,
  JobOwnership,
  JobRecord,
  JobStatus,
  JobStore,
  ListJobsOptions,
  PipelineEvent,
} from '@autonome-research/thread-phase';

/**
 * Compile-only fixture for the documented v5.0.0 public JobStore contract.
 * Bidirectional assignment catches both missing required methods and signature
 * drift (including boolean CAS results and owner-aware parameters).
 */
interface DocumentedV5JobStore {
  createJob(name: string, input: unknown): Promise<string>;
  acquireExclusive(name: string, input: unknown): Promise<string | null>;
  setRunning(jobId: string, ownership?: JobOwnership): Promise<boolean>;
  setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean>;
  setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean>;
  setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean>;
  setAbandoned(jobId: string, reason: string): Promise<boolean>;
  setAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<boolean>;
  finalizeJob(jobId: string, finalization: JobFinalization): Promise<EventRecord | null>;
  finalizeAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<EventRecord | null>;
  heartbeat(jobId: string, ownerId?: string): Promise<void>;
  enableHeartbeat(jobId: string, ownerId: string): Promise<boolean>;
  getJob(jobId: string, options?: GetJobOptions): Promise<JobRecord | null>;
  listJobs(options?: ListJobsOptions): Promise<JobRecord[]>;
  appendEvent(jobId: string, event: PipelineEvent): Promise<number>;
  getEvents(jobId: string, afterId?: number): Promise<EventRecord[]>;
  close(): void | Promise<void>;
}

declare const publicStore: JobStore;
declare const documentedStore: DocumentedV5JobStore;
const documentedFromPublic: DocumentedV5JobStore = publicStore;
const publicFromDocumented: JobStore = documentedStore;
const status: JobStatus = 'RUNNING';
void documentedFromPublic;
void publicFromDocumented;
void status;
