import type {
  JobStore as CurrentJobStore,
  PipelineEvent as CurrentPipelineEvent,
} from '@autonome-research/thread-phase';
import type {
  EventRecord,
  JobFinalization,
  GetJobOptions,
  JobOwnership,
  JobRecord,
  JobStore as ReleasedV5JobStore,
  ListJobsOptions,
} from './fixtures/v5.0.0/published/session/job-store.js';
import type { PipelineEvent as ReleasedV5PipelineEvent } from './fixtures/v5.0.0/published/phase.js';
import type { JobStore as ReleasedV5RootJobStore } from './fixtures/v5.0.0/published/index.js';
import type {
  JobStore as ReleasedV5SessionJobStore,
  SqliteJobStore as ReleasedV5SqliteJobStore,
} from './fixtures/v5.0.0/published/session/index.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

// Bidirectional checks use the independently sourced declaration artifact.
// Either assignment fails if required methods, parameters, or returns drift.
type _CurrentAcceptsReleased = Assert<ReleasedV5JobStore extends CurrentJobStore ? true : false>;
type _ReleasedAcceptsCurrent = Assert<CurrentJobStore extends ReleasedV5JobStore ? true : false>;
type _ExactStoreShape = Assert<Equal<CurrentJobStore, ReleasedV5JobStore>>;
type _ExactRootStoreShape = Assert<Equal<CurrentJobStore, ReleasedV5RootJobStore>>;
type _ExactSessionStoreShape = Assert<Equal<CurrentJobStore, ReleasedV5SessionJobStore>>;
type _ExactPipelineEventShape = Assert<Equal<CurrentPipelineEvent, ReleasedV5PipelineEvent>>;
type _NoUnpublishedSqliteAliases = Assert<Equal<
  Extract<keyof ReleasedV5SqliteJobStore, 'claimRunning' | 'heartbeatOwned'>,
  never
>>;
type _BooleanLifecycleReturn = Assert<Equal<
  ReturnType<ReleasedV5JobStore['setCompleted']>,
  Promise<boolean>
>>;
type _RequiredOwnedLifecycleMethods = Assert<Equal<
  Extract<
    keyof ReleasedV5JobStore,
    | 'finalizeJob'
    | 'finalizeAbandonedIfStale'
    | 'enableHeartbeat'
  >,
  'finalizeJob' | 'finalizeAbandonedIfStale' | 'enableHeartbeat'
>>;

/** Minimal structural store implementing only the compatibility artifact. */
export class V5CustomJobStore implements ReleasedV5JobStore {
  private nextJobId = 1;
  private nextEventId = 1;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly events: EventRecord[] = [];

  async createJob(name: string, input: unknown): Promise<string> {
    const id = `v5-${this.nextJobId++}`;
    this.jobs.set(id, {
      id,
      name,
      input,
      status: 'PENDING',
      result: null,
      error: null,
      eventCount: 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    });
    return id;
  }

  async acquireExclusive(name: string, input: unknown): Promise<string | null> {
    if ([...this.jobs.values()].some((job) => job.name === name && job.status === 'RUNNING')) {
      return null;
    }
    const id = await this.createJob(name, input);
    await this.setRunning(id);
    return id;
  }

  async setRunning(jobId: string, ownership?: JobOwnership): Promise<boolean> {
    const job = this.requireJob(jobId);
    if (job.status !== 'PENDING' && job.status !== 'RUNNING') return false;
    if (job.ownerId !== undefined && ownership?.ownerId !== undefined && job.ownerId !== ownership.ownerId) {
      return false;
    }
    job.status = 'RUNNING';
    job.startedAt ??= new Date();
    Object.assign(job, ownership);
    return true;
  }

  async setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean> {
    return this.transition(jobId, 'COMPLETED', result, undefined, ownerId);
  }

  async setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean> {
    return this.transition(jobId, 'FAILED', undefined, error, ownerId);
  }

  async setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean> {
    return this.transition(jobId, 'CANCELLED', undefined, reason, ownerId);
  }

  async setAbandoned(jobId: string, reason: string): Promise<boolean> {
    return this.transition(jobId, 'ABANDONED', undefined, reason);
  }

  async setAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<boolean> {
    return this.abandonIfStale(jobId, staleBefore, reason, expectedOwnerId);
  }

  async finalizeJob(jobId: string, finalization: JobFinalization): Promise<EventRecord | null> {
    const transitioned = this.transition(
      jobId,
      finalization.status,
      finalization.result,
      finalization.error,
      finalization.ownerId,
    );
    if (!transitioned) return null;
    return this.appendRecord(jobId, finalization.event);
  }

  async finalizeAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<EventRecord | null> {
    if (!this.abandonIfStale(jobId, staleBefore, reason, expectedOwnerId)) return null;
    return this.appendRecord(jobId, { type: 'abandoned', reason });
  }

  async heartbeat(jobId: string, ownerId?: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (job.status === 'RUNNING' && (ownerId === undefined || ownerId === job.ownerId)) {
      job.heartbeatAt = new Date();
    }
  }

  async enableHeartbeat(jobId: string, ownerId: string): Promise<boolean> {
    const job = this.requireJob(jobId);
    if (job.status !== 'RUNNING' || job.ownerId !== ownerId) return false;
    job.heartbeatEnabled = true;
    job.heartbeatAt = new Date();
    return true;
  }

  async getJob(jobId: string, _options?: GetJobOptions): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async listJobs(options: ListJobsOptions = {}): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => options.name === undefined || job.name === options.name)
      .filter((job) => options.status === undefined || job.status === options.status)
      .slice(0, options.limit ?? 50);
  }

  async appendEvent(jobId: string, event: ReleasedV5PipelineEvent): Promise<number> {
    return this.appendRecord(jobId, event).id;
  }

  async getEvents(jobId: string, afterId = 0): Promise<EventRecord[]> {
    return this.events.filter((event) => event.jobId === jobId && event.id > afterId);
  }

  close(): void {}

  private appendRecord(jobId: string, event: ReleasedV5PipelineEvent): EventRecord {
    const job = this.requireJob(jobId);
    const record = {
      id: this.nextEventId++,
      jobId,
      eventType: event.type,
      data: event,
      createdAt: new Date(),
    };
    this.events.push(record);
    job.eventCount++;
    return record;
  }

  private abandonIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): boolean {
    const job = this.requireJob(jobId);
    if (job.status !== 'RUNNING' || job.heartbeatEnabled !== true) return false;
    if (expectedOwnerId !== undefined && job.ownerId !== expectedOwnerId) return false;
    if (job.heartbeatAt !== undefined && job.heartbeatAt >= staleBefore) return false;
    return this.transition(jobId, 'ABANDONED', undefined, reason);
  }

  private transition(
    jobId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED',
    result?: unknown,
    error?: string,
    ownerId?: string,
  ): boolean {
    const job = this.requireJob(jobId);
    if (job.status !== 'PENDING' && job.status !== 'RUNNING') return false;
    if (ownerId !== undefined && job.ownerId !== ownerId) return false;
    job.status = status;
    job.result = result ?? null;
    job.error = error ?? null;
    job.completedAt = new Date();
    return true;
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    return job;
  }
}

const currentFromReleased: CurrentJobStore = new V5CustomJobStore();
const releasedFromCurrent: ReleasedV5JobStore = currentFromReleased;
void releasedFromCurrent;
